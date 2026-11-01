package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// A subscription belongs to a session. Each matching source event is copied
// once into that session's inbox, even if several subscriptions match it.
type sdkChatSubscription struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	Sources   []string  `json:"sources"`
	Topics    []string  `json:"topics"`
	CreatedAt time.Time `json:"createdAt"`
}

type sdkInboxEvent struct {
	ID              string    `json:"id"`
	SourceSessionID string    `json:"sourceSessionId"`
	SourceEventID   string    `json:"sourceEventId"`
	Subscriptions   []string  `json:"subscriptions"`
	Topic           string    `json:"topic"`
	At              time.Time `json:"at"`
	Event           sdkEvent  `json:"event"`
}

func (h *sdkChatHost) subscriptionPath() string {
	return filepath.Join(h.dir, "subscriptions.json")
}

func (h *sdkChatHost) inboxPath(id string) string {
	return filepath.Join(h.dir, "inbox", id+".ndjson")
}

func (h *sdkChatHost) loadSubscriptions() {
	data, err := os.ReadFile(h.subscriptionPath())
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("read chat subscriptions: %v", err)
		return
	}
	if err := json.Unmarshal(data, &h.subscriptions); err != nil || h.subscriptions == nil {
		log.Printf("decode chat subscriptions: %v", err)
		h.subscriptions = map[string]*sdkChatSubscription{}
	}
	for id, sub := range h.subscriptions {
		if sub == nil || sub.ID != id || sub.SessionID == "" {
			delete(h.subscriptions, id)
		}
	}
}

// Caller holds h.mu. Persistence precedes the in-memory change.
func (h *sdkChatHost) saveSubscriptionsLocked(next map[string]*sdkChatSubscription) error {
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	if err := atomicfile.Write(h.subscriptionPath(), data, 0600); err != nil {
		return err
	}
	h.subscriptions = next
	return nil
}

func sdkEventTopics(event sdkEvent) []string {
	if event.Type == "topic.published" {
		return []string{event.Topic}
	}
	if strings.HasPrefix(event.Type, "work.") {
		return []string{"work"}
	}
	switch event.Type {
	case "goal.progress":
		return []string{"goal", "lifecycle"}
	case "input.accepted", "input.delivered":
		return []string{"input", "lifecycle"}
	case "turn.completed", "turn.cancelled":
		return []string{"lifecycle"}
	case "error", "session.uncertain":
		return []string{"error", "lifecycle"}
	case "session.renamed":
		return []string{"session"}
	}
	return nil
}

func validSDKTopic(topic string) bool {
	if len(topic) == 0 || len(topic) > 64 {
		return false
	}
	for _, r := range topic {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func (h *sdkChatHost) planSubscriptionsLocked(event sdkEvent) sdkPendingDelivery {
	plan := sdkPendingDelivery{Event: event}
	topics := sdkEventTopics(event)
	if len(topics) == 0 {
		return plan
	}
	type delivery struct {
		matches []string
		topic   string
	}
	owners := map[string]delivery{}
	for _, sub := range h.subscriptions {
		if sub == nil {
			continue
		}
		if h.chats[sub.SessionID] == nil || !slices.Contains(sub.Sources, event.SessionID) {
			continue
		}
		for _, topic := range topics {
			if slices.Contains(sub.Topics, topic) {
				item := owners[sub.SessionID]
				item.matches = append(item.matches, sub.ID)
				if item.topic == "" {
					item.topic = topic
				}
				owners[sub.SessionID] = item
				break
			}
		}
	}
	for owner, delivery := range owners {
		sort.Strings(delivery.matches)
		item := sdkInboxEvent{ID: sdkID(), SourceSessionID: event.SessionID, SourceEventID: event.ID,
			Subscriptions: delivery.matches, Topic: delivery.topic, At: event.At, Event: event}
		plan.Inbox = append(plan.Inbox, sdkPendingInbox{OwnerSessionID: owner, Item: item})
	}
	sort.Slice(plan.Inbox, func(i, j int) bool { return plan.Inbox[i].OwnerSessionID < plan.Inbox[j].OwnerSessionID })
	return plan
}

func (s *Server) handleSDKSubscriptions(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	owner := r.PathValue("id")
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.chats[owner] == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		rows := make([]sdkChatSubscription, 0)
		for _, sub := range h.subscriptions {
			if sub.SessionID == owner {
				rows = append(rows, *sub)
			}
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
		writeSDKJSON(w, 200, map[string]any{"subscriptions": rows})
		return
	}
	var req struct {
		Sources []string `json:"sources"`
		Topics  []string `json:"topics"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req) != nil || len(req.Sources) == 0 || len(req.Sources) > 32 || len(req.Topics) == 0 || len(req.Topics) > 16 {
		http.Error(w, "1-32 sources and 1-16 topics required", 400)
		return
	}
	for _, source := range req.Sources {
		if h.chats[source] == nil {
			http.Error(w, "unknown source session: "+source, 422)
			return
		}
	}
	for _, topic := range req.Topics {
		if !validSDKTopic(topic) {
			http.Error(w, "invalid topic: "+topic, 422)
			return
		}
	}
	sort.Strings(req.Sources)
	req.Sources = slices.Compact(req.Sources)
	sort.Strings(req.Topics)
	req.Topics = slices.Compact(req.Topics)
	for _, sub := range h.subscriptions {
		if sub.SessionID == owner && slices.Equal(sub.Sources, req.Sources) && slices.Equal(sub.Topics, req.Topics) {
			writeSDKJSON(w, 200, sub)
			return
		}
	}
	count := 0
	for _, sub := range h.subscriptions {
		if sub.SessionID == owner {
			count++
		}
	}
	if count >= 64 {
		http.Error(w, "session has reached 64 subscriptions", 422)
		return
	}
	sub := &sdkChatSubscription{ID: sdkID(), SessionID: owner, Sources: req.Sources, Topics: req.Topics, CreatedAt: time.Now().UTC()}
	next := make(map[string]*sdkChatSubscription, len(h.subscriptions)+1)
	for k, v := range h.subscriptions {
		next[k] = v
	}
	next[sub.ID] = sub
	if err := h.saveSubscriptionsLocked(next); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 201, sub)
}

func (s *Server) handleSDKSubscription(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	owner, id := r.PathValue("id"), r.PathValue("subscription")
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.chats[owner] == nil || h.subscriptions[id] == nil || h.subscriptions[id].SessionID != owner {
		http.NotFound(w, r)
		return
	}
	next := make(map[string]*sdkChatSubscription, len(h.subscriptions)-1)
	for k, v := range h.subscriptions {
		if k != id {
			next[k] = v
		}
	}
	if err := h.saveSubscriptionsLocked(next); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 200, map[string]any{"removed": id})
}

func (s *Server) handleSDKPublishTopic(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct{ Topic, Text string }
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || !validSDKTopic(req.Topic) || len(req.Text) > 32<<10 || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "valid topic and nonempty text required", 400)
		return
	}
	if slices.Contains([]string{"goal", "lifecycle", "input", "session", "error", "work"}, req.Topic) {
		http.Error(w, "reserved topic", 422)
		return
	}
	s.sdkChats.mu.Lock()
	_, exists := s.sdkChats.chats[id]
	s.sdkChats.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	event := sdkEvent{SessionID: id, Type: "topic.published", Topic: req.Topic, Text: req.Text}
	s.sdkChats.appendEvent(event)
	writeSDKJSON(w, 202, map[string]any{"published": true, "topic": req.Topic})
}

func (s *Server) handleSDKInbox(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if r.URL.Query().Get("after") == "" {
		after, err = 0, nil
	}
	if err != nil || after < 0 {
		http.Error(w, "invalid inbox cursor", 400)
		return
	}
	limit := 100
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 500 {
			http.Error(w, "limit must be 1-500", 400)
			return
		}
	}
	waitMS := 0
	if value := r.URL.Query().Get("wait_ms"); value != "" {
		waitMS, err = strconv.Atoi(value)
		if err != nil || waitMS < 0 || waitMS > 30000 {
			http.Error(w, "wait_ms must be 0-30000", 400)
			return
		}
	}
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.chats[id] == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if h.inboxStreams[id] == nil {
		h.inboxStreams[id] = map[chan struct{}]struct{}{}
	}
	h.inboxStreams[id][ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.inboxStreams[id], ch)
		h.mu.Unlock()
	}()
	deadline := time.NewTimer(time.Duration(waitMS) * time.Millisecond)
	defer deadline.Stop()
	for {
		items, cursor, end, readErr := h.readInbox(id, after, limit)
		if readErr != nil {
			http.Error(w, readErr.Error(), 400)
			return
		}
		if len(items) > 0 || waitMS == 0 {
			writeSDKJSON(w, 200, map[string]any{"events": items, "cursor": cursor, "hasMore": cursor < end})
			return
		}
		select {
		case <-ch:
		case <-deadline.C:
			writeSDKJSON(w, 200, map[string]any{"events": items, "cursor": cursor, "hasMore": false})
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (h *sdkChatHost) readInbox(id string, after int64, limit int) ([]sdkInboxEvent, int64, int64, error) {
	h.mu.Lock()
	f, err := os.Open(h.inboxPath(id))
	if errors.Is(err, os.ErrNotExist) {
		h.mu.Unlock()
		if after != 0 {
			return nil, after, 0, fmt.Errorf("cursor beyond inbox")
		}
		return []sdkInboxEvent{}, 0, 0, nil
	}
	if err != nil {
		h.mu.Unlock()
		return nil, after, 0, err
	}
	info, err := f.Stat()
	h.mu.Unlock()
	defer f.Close()
	if err != nil {
		return nil, after, 0, err
	}
	end := info.Size()
	if after > end {
		return nil, after, end, fmt.Errorf("cursor beyond inbox")
	}
	reader := bufio.NewReader(io.NewSectionReader(f, after, end-after))
	items := make([]sdkInboxEvent, 0, min(limit, 100))
	cursor := after
	for cursor < end && len(items) < limit {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return nil, cursor, end, err
		}
		cursor += int64(len(line))
		var item sdkInboxEvent
		if err := json.Unmarshal(line, &item); err != nil {
			return nil, cursor, end, err
		}
		items = append(items, item)
	}
	return items, cursor, end, nil
}
