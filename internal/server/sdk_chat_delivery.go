package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// A delivery record captures the subscribers at event time. It is committed
// before either append, so a restart can finish an interrupted fanout even if
// a subscription was subsequently removed.
type sdkPendingDelivery struct {
	Event sdkEvent          `json:"event"`
	Inbox []sdkPendingInbox `json:"inbox"`
}

type sdkPendingInbox struct {
	OwnerSessionID string        `json:"ownerSessionId"`
	Item           sdkInboxEvent `json:"item"`
}

func (h *sdkChatHost) pendingDeliveryDir() string {
	return filepath.Join(h.dir, "pending-delivery")
}

func (h *sdkChatHost) pendingDeliveryPath(id string) string {
	return filepath.Join(h.pendingDeliveryDir(), id+".json")
}

// Caller holds h.mu, or runs before the host becomes visible to other goroutines.
func (h *sdkChatHost) savePendingDeliveryLocked(plan sdkPendingDelivery) error {
	data, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(h.pendingDeliveryDir(), 0700); err != nil {
		return err
	}
	return atomicfile.Write(h.pendingDeliveryPath(plan.Event.ID), data, 0600)
}

func (h *sdkChatHost) removePendingDelivery(id string) error {
	if err := os.Remove(h.pendingDeliveryPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func appendSDKLine(path string, value any) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	if err == nil {
		err = f.Sync()
	}
	return errors.Join(err, f.Close())
}

// A failed recipient remains in the durable delivery record; completed
// recipients are recognized by sourceEventId on replay. A separate mutex
// keeps inbox file appends serialized without blocking all chat activity.
func (h *sdkChatHost) deliverPending(plan sdkPendingDelivery) error {
	h.inboxDeliveryMu.Lock()
	defer h.inboxDeliveryMu.Unlock()
	var failures []error
	for _, recipient := range plan.Inbox {
		if err := appendSDKLine(h.inboxPath(recipient.OwnerSessionID), recipient.Item); err != nil {
			failures = append(failures, fmt.Errorf("inbox %s: %w", recipient.OwnerSessionID, err))
			continue
		}
		h.mu.Lock()
		for ch := range h.inboxStreams[recipient.OwnerSessionID] {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
		h.mu.Unlock()
	}
	return errors.Join(failures...)
}

// ensureSDKLine recovers an append-only journal after an interrupted write.
// A partial tail is discarded; a complete matching event is never appended
// twice. This is used only for pending deliveries during host startup.
func ensureSDKLine(path, eventID string, value any, inbox bool) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	var offset int64
	found := false
	truncated := false
	for {
		entry, readErr := reader.ReadBytes('\n')
		if errors.Is(readErr, io.EOF) {
			if len(entry) > 0 {
				if err := f.Truncate(offset); err != nil {
					return errors.Join(err, f.Close())
				}
				truncated = true
			}
			break
		}
		if readErr != nil {
			return errors.Join(readErr, f.Close())
		}
		offset += int64(len(entry))
		var probe struct {
			ID            string `json:"id"`
			SourceEventID string `json:"sourceEventId"`
		}
		if err := json.Unmarshal(entry, &probe); err != nil {
			return errors.Join(fmt.Errorf("decode %s at %d: %w", path, offset, err), f.Close())
		}
		matched := probe.ID == eventID
		if inbox {
			matched = probe.SourceEventID == eventID
		}
		found = found || matched
	}
	if truncated {
		if err := f.Sync(); err != nil {
			return errors.Join(err, f.Close())
		}
	}
	if found {
		return f.Close()
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		return errors.Join(err, f.Close())
	}
	_, err = f.Write(append(line, '\n'))
	if err == nil {
		err = f.Sync()
	}
	return errors.Join(err, f.Close())
}

func (h *sdkChatHost) recoverPendingDeliveries() {
	entries, err := os.ReadDir(h.pendingDeliveryDir())
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("read pending chat deliveries: %v", err)
		return
	}
	// Entry names are random IDs, so sort plans by event time for predictable
	// replay order when more than one delivery was interrupted.
	var plans []sdkPendingDelivery
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(h.pendingDeliveryDir(), entry.Name()))
		if err != nil {
			log.Printf("read pending chat delivery %s: %v", entry.Name(), err)
			continue
		}
		var plan sdkPendingDelivery
		if err := json.Unmarshal(data, &plan); err != nil || plan.Event.ID == "" || plan.Event.ID+".json" != entry.Name() {
			log.Printf("invalid pending chat delivery %s: %v", entry.Name(), err)
			continue
		}
		plans = append(plans, plan)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].Event.At.Before(plans[j].Event.At) })
	for _, plan := range plans {
		if h.chats[plan.Event.SessionID] == nil {
			log.Printf("pending chat delivery %s has unknown source session", plan.Event.ID)
			if err := h.removePendingDelivery(plan.Event.ID); err != nil {
				log.Printf("remove orphaned chat delivery %s: %v", plan.Event.ID, err)
			}
			continue
		}
		path := filepath.Join(h.dir, plan.Event.SessionID+".ndjson")
		if err := ensureSDKLine(path, plan.Event.ID, plan.Event, false); err != nil {
			log.Printf("recover source chat event %s: %v", plan.Event.ID, err)
			continue
		}
		failed := false
		for _, recipient := range plan.Inbox {
			if h.chats[recipient.OwnerSessionID] == nil {
				log.Printf("pending chat delivery %s skips deleted recipient %s", plan.Event.ID, recipient.OwnerSessionID)
				continue
			}
			if recipient.Item.SourceEventID != plan.Event.ID {
				log.Printf("pending chat delivery %s has invalid recipient", plan.Event.ID)
				failed = true
				continue
			}
			if err := ensureSDKLine(h.inboxPath(recipient.OwnerSessionID), plan.Event.ID, recipient.Item, true); err != nil {
				log.Printf("recover chat inbox event %s: %v", plan.Event.ID, err)
				failed = true
			}
		}
		if !failed {
			if err := h.removePendingDelivery(plan.Event.ID); err != nil {
				log.Printf("remove recovered chat delivery %s: %v", plan.Event.ID, err)
			}
		}
	}
}
