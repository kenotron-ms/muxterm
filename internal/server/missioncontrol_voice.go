package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/cos"
	"github.com/kenotron-ms/muxterm/internal/missioncontrol"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
	"github.com/kenotron-ms/muxterm/internal/voice"
)

// Mission Control text threads intentionally begin voice-disabled.  This
// surface exposes the lease/focus/capture safety negotiation needed for a
// future attachment, but never creates a provider session or accepts audio.
const missionControlVoiceOwnerCookie = "muxterm_missioncontrol_voice_owner"
const missionControlVoiceControlHeader = "X-MissionControl-Voice-Control"
const missionControlVoiceCandidateTTL = 60 * time.Second
const missionControlVoiceProtocolVersion = 3

type missionControlVoiceRequest struct {
	ProtocolVersion    int    `json:"protocol_version"`
	SessionID          string `json:"session_id"`
	ThreadID           string `json:"thread_id"`
	RuntimeSessionID   string `json:"runtime_session_id"`
	RuntimeGeneration  uint64 `json:"runtime_generation"`
	RuntimeIncarnation string `json:"runtime_incarnation"`
	LeaseEpoch         uint64 `json:"lease_epoch"`
	FocusEpoch         uint64 `json:"focus_epoch"`
	CaptureEpoch       uint64 `json:"capture_epoch"`
	AttachmentEpoch    uint64 `json:"attachment_epoch"`
	CaptureID          string `json:"capture_id"`
	PrefixNonce        string `json:"prefix_nonce"`
	DrainNonce         string `json:"drain_nonce"`
	Cursor             uint64 `json:"cursor"`
	Takeover           bool   `json:"takeover"`
}

type missionControlVoiceAttachment struct {
	correlation      voice.VoiceCorrelation
	leaseEpoch       uint64
	focusEpoch       uint64
	attachmentEpoch  uint64
	bridgeID         string
	controlToken     string
	sessionID        string
	bridge           *missionControlScopedBridge
	sideband         *voice.Sideband
	failed           bool // protected by bridge.mu, including before publication
	committed        bool
	connecting       bool // protected by missionControlVoiceAttachmentMu
	draining         bool
	providerCleared  bool
	providerTerminal bool
	clientDrained    bool
	drainNonce       string
	capture          *missionControlCapture
	inputIDs         map[string]struct{}
	events           []missionControlVoiceEvent
	nextEvent        uint64
	eventWake        chan struct{}
	onDrainReady     func()
	onCaptureSettled func(voice.CaptureGrant)
	onPrefixTimeout  func(string)
	routeAnnounced   bool
	prefixNonce      string
	prefixKind       string
	prefixCaptureID  string
	// deliveryCtx bounds provider-side waits only. Cancelling it never cancels
	// the Mission Control turn that was already admitted.
	deliveryMu     sync.Mutex
	deliveryClosed bool
	deliveryCtx    context.Context
	deliveryCancel context.CancelFunc
	deliveryWG     sync.WaitGroup
}

type missionControlCapture struct {
	grant             voice.CaptureGrant
	phase             string // reserved|ended|committed|prefix|response|settled
	inputItem         string
	responseID        string
	prefixNonce       string
	outputCalls       map[string]string // output item -> provider call id
	turn              voice.TurnHandle
	replyCallID       string
	replyText         string
	queuedReply       string
	queuedCallID      string
	replyTerminal     bool
	queuedTerminal    bool
	replyInFlight     bool
	terminalReplyDone bool
	turnDone          bool
	dispatchCall      string
	dispatching       bool
	responseDone      bool
	audioStopped      bool
	hadAudio          bool
}

type missionControlVoiceEvent struct {
	Cursor          uint64 `json:"cursor"`
	Type            string `json:"type"`
	Nonce           string `json:"nonce,omitempty"`
	Kind            string `json:"kind,omitempty"`
	AttachmentEpoch uint64 `json:"attachment_epoch"`
	FocusEpoch      uint64 `json:"focus_epoch"`
	CaptureID       string `json:"capture_id,omitempty"`
	Message         string `json:"message,omitempty"`
}

// missionControlScopedBridge is born for one attachment and can never be
// retargeted. Its ordinary Bridge methods fail closed so legacy Sideband paths
// cannot accidentally submit to the global CoS.
type missionControlScopedBridge struct {
	correlation     voice.VoiceCorrelation
	attachmentEpoch uint64
	catalog         *missioncontrol.Store
	runtime         *missioncontrol.Runtime
	attachment      *missionControlVoiceAttachment
	validate        func() error
	mu              sync.Mutex
}

func (b *missionControlScopedBridge) Submit(string) (voice.TurnHandle, error) {
	return nil, errors.New("voice: uncorrelated submit is forbidden on a Mission Control attachment")
}

func (b *missionControlScopedBridge) Approve(string, bool, string) error {
	return errors.New("voice: approvals require explicit Mission Control text controls")
}

func (b *missionControlScopedBridge) Cancel(string) error {
	return errors.New("voice: cancellation requires an explicit Mission Control text control")
}

func (b *missionControlScopedBridge) SidebandTerminal(reason string) {
	b.mu.Lock()
	if b.attachment.failed {
		b.mu.Unlock()
		return
	}
	b.attachment.failed = true
	b.attachment.sideband = nil
	b.attachment.routeAnnounced = false
	b.attachment.emitLocked("attachment_failed", "", "provider", "", boundedVoiceLabel(reason))
	b.mu.Unlock()
	b.attachment.stopDeliveryWaits()
}

// SidebandClosed is called by Sideband.Close for a local owner stop or server
// shutdown. A drain's intentional close is not a provider failure, but it must
// stop attachment-owned delivery waits.
func (b *missionControlScopedBridge) SidebandClosed() {
	b.attachment.stopDeliveryWaits()
}

func (b *missionControlScopedBridge) QueueScopedReply(c voice.Correlation, callID, output string, terminal bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	capture := b.attachment.capture
	if b.attachment.failed || b.attachment.draining || b.attachment.sideband == nil ||
		capture == nil || capture.grant.CaptureID != c.CaptureID ||
		(capture.phase != "response" && capture.phase != "prefix" && capture.phase != "response_request") {
		return errors.New("voice: scoped reply has no immutable capture response")
	}
	if (terminal && capture.terminalReplyDone) ||
		(output == capture.replyText && terminal == capture.replyTerminal) ||
		(output == capture.queuedReply && terminal == capture.queuedTerminal) {
		return nil
	}
	capture.dispatching = false
	if capture.replyText != "" || capture.replyInFlight || capture.phase != "response" {
		if capture.queuedReply != "" {
			return errors.New("voice: scoped reply queue is full")
		}
		capture.queuedReply, capture.queuedCallID, capture.queuedTerminal = output, callID, terminal
		return nil
	}
	if callID != "" {
		if !b.attachment.sideband.SendScopedFunctionOutput(callID, output) {
			return errors.New("voice: could not deliver scoped tool result")
		}
	} else if !b.attachment.sideband.SendScopedCompletion(output) {
		return errors.New("voice: could not deliver scoped completion")
	}
	capture.replyCallID, capture.replyText, capture.replyTerminal = callID, output, terminal
	b.advanceCaptureLocked(capture)
	return nil
}

func (b *missionControlScopedBridge) ReserveToolCall(event voice.ProviderEvent) (voice.Correlation, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	capture := b.attachment.capture
	if capture == nil || capture.phase != "response" || event.ResponseID != capture.responseID {
		return voice.Correlation{}, errors.New("voice: tool call has no active scoped response")
	}
	callID := capture.outputCalls[event.ItemID]
	if callID == "" || (event.CallRef != "" && event.CallRef != callID) {
		return voice.Correlation{}, errors.New("voice: tool call has no verified output-item mapping")
	}
	if capture.dispatchCall != "" && capture.dispatchCall != callID {
		return voice.Correlation{}, errors.New("voice: second work call for capture is refused")
	}
	capture.dispatchCall, capture.dispatching = callID, true
	return voice.Correlation{ProviderCallID: callID, ProviderItemID: capture.inputItem, ProviderResponseID: capture.responseID, CaptureID: capture.grant.CaptureID, AttachmentEpoch: b.attachmentEpoch}, nil
}

func (b *missionControlScopedBridge) SubmitCorrelated(c voice.Correlation, prompt string) (voice.TurnHandle, error) {
	if c.AttachmentEpoch != b.attachmentEpoch || c.CaptureID == "" || c.ProviderCallID == "" ||
		c.ProviderItemID == "" || c.ProviderResponseID == "" {
		return nil, errors.New("voice: provider tool event is not mapped to this attachment capture")
	}
	if b.runtime.Thread.ID != b.correlation.ThreadID ||
		b.runtime.Thread.RuntimeSessionID != b.correlation.RuntimeSessionID ||
		b.runtime.Thread.RuntimeGeneration != b.correlation.RuntimeGeneration ||
		b.runtime.Thread.RuntimeIncarnation != b.correlation.RuntimeIncarnation {
		return nil, errors.New("voice: selected Mission Control runtime is stale")
	}
	if b.validate == nil || b.validate() != nil {
		return nil, errors.New("voice: selected Mission Control runtime is no longer live")
	}
	b.mu.Lock()
	capture := b.attachment.capture
	if capture == nil || capture.grant.CaptureID != c.CaptureID || capture.phase != "response" ||
		c.ProviderItemID != capture.inputItem || c.ProviderResponseID != capture.responseID {
		b.mu.Unlock()
		return nil, errors.New("voice: provider call is not mapped to the current settled capture")
	}
	if capture.turn != nil {
		if c.ProviderCallID == capture.dispatchCall {
			turn := capture.turn
			b.mu.Unlock()
			return turn, nil
		}
		b.mu.Unlock()
		return nil, errors.New("voice: a second work call for this capture is refused")
	}
	if capture.dispatchCall != c.ProviderCallID {
		b.mu.Unlock()
		return nil, errors.New("voice: work dispatch was not reader-reserved for this capture")
	}
	if capture.turn != nil {
		turn := capture.turn
		b.mu.Unlock()
		return turn, nil
	}
	b.mu.Unlock()
	requestID := uuid.New().String()
	payload, err := json.Marshal(struct {
		ThreadID           string `json:"thread_id"`
		RuntimeGeneration  uint64 `json:"runtime_generation"`
		ProviderCallID     string `json:"provider_call_id"`
		ProviderItemID     string `json:"provider_item_id"`
		ProviderResponseID string `json:"provider_response_id"`
		CaptureID          string `json:"capture_id"`
		AttachmentEpoch    uint64 `json:"attachment_epoch"`
		Text               string `json:"text"`
	}{
		b.correlation.ThreadID, b.correlation.RuntimeGeneration, c.ProviderCallID,
		c.ProviderItemID, c.ProviderResponseID, c.CaptureID, c.AttachmentEpoch, prompt,
	})
	if err != nil {
		b.mu.Lock()
		if b.attachment.capture == capture {
			capture.dispatching = false
		}
		b.mu.Unlock()
		return nil, errors.New("voice: could not encode correlated Mission Control request")
	}
	if _, duplicate, err := b.catalog.Admit(requestID, b.correlation.ThreadID, b.correlation.RuntimeGeneration, payload); err != nil || duplicate {
		b.mu.Lock()
		if b.attachment.capture == capture {
			capture.dispatching = false
		}
		b.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("voice: correlated Mission Control request was already admitted")
	}
	turn, err := b.runtime.Submit(requestID, prompt, "voice:"+c.CaptureID)
	if err != nil {
		b.mu.Lock()
		if b.attachment.capture == capture {
			capture.dispatching = false
		}
		b.mu.Unlock()
		return nil, err
	}
	handle := &voiceTurnHandle{turn: turn}
	b.mu.Lock()
	if b.attachment.capture != capture || capture.turn != nil {
		b.mu.Unlock()
		return nil, errors.New("voice: capture changed while dispatching")
	}
	capture.turn, capture.dispatching = handle, false
	b.attachment.startDeliveryWait(func(ctx context.Context) {
		b.awaitCaptureTurn(ctx, capture, handle)
	})
	b.mu.Unlock()
	return handle, nil
}

func (b *missionControlScopedBridge) ObserveProviderEvent(event voice.ProviderEvent) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	capture := b.attachment.capture
	switch event.Type {
	case "input_audio_buffer.committed":
		if capture == nil || capture.phase != "reserved" && capture.phase != "ended" || event.ItemID == "" {
			return errors.New("voice: unsolicited or ambiguous provider input commit")
		}
		if _, duplicate := b.attachment.inputIDs[event.ItemID]; duplicate || len(b.attachment.inputIDs) >= 32 {
			return errors.New("voice: duplicate or unbounded provider input item mapping")
		}
		b.attachment.inputIDs[event.ItemID] = struct{}{}
		wasEnded := capture.phase == "ended"
		capture.inputItem = event.ItemID
		capture.phase = "committed"
		if wasEnded {
			b.emitPrefixLocked(capture, "answer")
		}
	case "conversation.item.input_audio_transcription.completed":
		if capture == nil || capture.inputItem == "" || event.ItemID != capture.inputItem {
			return errors.New("voice: transcription is not bound to the reserved provider input item")
		}
	case "response.created":
		if capture == nil || capture.phase != "response_request" || event.ResponseID == "" ||
			event.Metadata["muxterm_capture_id"] != capture.grant.CaptureID ||
			event.Metadata["muxterm_prefix_nonce"] != capture.prefixNonce ||
			event.Metadata["muxterm_attachment_epoch"] != fmt.Sprint(b.attachment.attachmentEpoch) {
			return errors.New("voice: unsolicited or mismatched provider response")
		}
		capture.responseID = event.ResponseID
		capture.phase = "response"
		capture.responseDone, capture.audioStopped, capture.hadAudio = false, false, false
	case "response.output_item.added", "response.output_item.done":
		if capture == nil || capture.phase != "response" || event.ResponseID != capture.responseID {
			return errors.New("voice: output item is not bound to current response")
		}
		if event.OutputID != "" && event.CallRef != "" {
			capture.outputCalls[event.OutputID] = event.CallRef
		}
	case "response.done", "response.cancelled":
		if capture != nil && event.ResponseID == capture.responseID && !capture.responseDone {
			capture.responseDone = true
			if capture.replyInFlight {
				capture.terminalReplyDone = capture.terminalReplyDone || capture.replyTerminal
				capture.replyText, capture.replyCallID = "", ""
				capture.replyInFlight, capture.replyTerminal = false, false
			}
			b.advanceCaptureLocked(capture)
		}
		if b.attachment.draining && (capture == nil || event.ResponseID == capture.responseID) {
			b.attachment.providerTerminal = true
			if b.attachment.providerCleared && b.attachment.clientDrained && b.attachment.onDrainReady != nil {
				go b.attachment.onDrainReady()
			}
		}
	case "output_audio_buffer.started":
		if capture != nil && event.ResponseID == capture.responseID {
			capture.hadAudio = true
		}
	case "output_audio_buffer.cleared", "output_audio_buffer.stopped":
		if capture != nil && event.ResponseID == capture.responseID {
			capture.audioStopped = true
			b.advanceCaptureLocked(capture)
			if capture.responseDone && capture.replyText != "" {
				b.emitPrefixLocked(capture, "answer")
			}
		}
		if b.attachment.draining {
			b.attachment.providerCleared = true
			if b.attachment.providerTerminal && b.attachment.clientDrained && b.attachment.onDrainReady != nil {
				go b.attachment.onDrainReady()
			}
		}
	}
	return nil
}

func (b *missionControlScopedBridge) awaitCaptureTurn(ctx context.Context, capture *missionControlCapture, turn voice.TurnHandle) {
	_, _ = turn.Wait(ctx)
	if ctx.Err() != nil {
		return
	}
	b.mu.Lock()
	if b.attachment.capture != capture || capture.turn != turn {
		b.mu.Unlock()
		return
	}
	capture.turnDone = true
	b.advanceCaptureLocked(capture)
	b.mu.Unlock()
}

// Work completion and narration completion are separate boundaries. In
// particular, a finished root must not discard an outstanding prefix nonce.
func (b *missionControlScopedBridge) advanceCaptureLocked(capture *missionControlCapture) {
	if b.attachment.capture != capture || b.attachment.failed || b.attachment.draining ||
		capture.phase != "response" || !capture.responseDone || capture.dispatching ||
		(capture.hadAudio && !capture.audioStopped) {
		return
	}
	if capture.replyText == "" && capture.queuedReply != "" {
		var sent bool
		if capture.queuedCallID != "" {
			sent = b.attachment.sideband.SendScopedFunctionOutput(capture.queuedCallID, capture.queuedReply)
		} else {
			sent = b.attachment.sideband.SendScopedCompletion(capture.queuedReply)
		}
		if !sent {
			b.attachment.failed = true
			b.attachment.emitLocked("attachment_failed", "", "provider", "", "Queued completion could not be delivered.")
			return
		}
		capture.replyText, capture.replyCallID, capture.replyTerminal = capture.queuedReply, capture.queuedCallID, capture.queuedTerminal
		capture.queuedReply, capture.queuedCallID, capture.queuedTerminal = "", "", false
	}
	if capture.replyText != "" {
		b.emitPrefixLocked(capture, "answer")
		return
	}
	if capture.dispatchCall != "" && (!capture.terminalReplyDone || (capture.turn != nil && !capture.turnDone)) {
		return
	}
	capture.phase = "settled"
	go b.attachment.settleCapture(capture.grant)
}

func (b *missionControlScopedBridge) ResolveToolCall(event voice.ProviderEvent) (voice.Correlation, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	capture := b.attachment.capture
	if capture == nil || capture.phase != "response" || (event.ResponseID != "" && event.ResponseID != capture.responseID) {
		return voice.Correlation{}, errors.New("voice: final tool call has no current response mapping")
	}
	callID := capture.outputCalls[event.ItemID]
	if callID == "" || (event.CallRef != "" && event.CallRef != callID) {
		return voice.Correlation{}, errors.New("voice: final tool call has no verified output-item mapping")
	}
	return voice.Correlation{
		ProviderCallID: callID, ProviderItemID: capture.inputItem,
		ProviderResponseID: capture.responseID, CaptureID: capture.grant.CaptureID,
		AttachmentEpoch: b.attachment.attachmentEpoch,
	}, nil
}

func (b *missionControlScopedBridge) PrefixAcknowledged(nonce string) error {
	b.mu.Lock()
	if b.attachment.failed || b.attachment.draining || b.attachment.sideband == nil {
		b.mu.Unlock()
		return errors.New("voice: attachment cannot acknowledge a prefix after failure or drain")
	}
	capture := b.attachment.capture
	if b.attachment.prefixNonce == nonce && b.attachment.prefixKind == "route" && !b.attachment.routeAnnounced {
		b.attachment.routeAnnounced = true
		b.attachment.prefixNonce, b.attachment.prefixKind = "", ""
		b.mu.Unlock()
		return nil
	}
	if capture == nil || capture.phase != "prefix" || capture.prefixNonce != nonce || b.attachment.sideband == nil {
		b.mu.Unlock()
		return errors.New("voice: prefix acknowledgement is stale")
	}
	metadata := map[string]string{
		"muxterm_capture_id": capture.grant.CaptureID, "muxterm_prefix_nonce": nonce,
		"muxterm_attachment_epoch": fmt.Sprint(b.attachment.attachmentEpoch),
	}
	capture.phase = "response_request"
	capture.replyInFlight = capture.replyText != ""
	sideband := b.attachment.sideband
	b.mu.Unlock()
	if err := sideband.RequestScopedResponse(metadata); err != nil {
		b.mu.Lock()
		if b.attachment.capture == capture && capture.phase == "response_request" {
			capture.phase = "settled"
		}
		b.mu.Unlock()
		return err
	}
	return nil
}

func (b *missionControlScopedBridge) requestPrefixWhenEnded(capture *missionControlCapture) {
	b.mu.Lock()
	if b.attachment.capture != capture || capture.phase != "committed" {
		b.mu.Unlock()
		return
	}
	// A committed input can arrive before browser media has ended. Do not
	// create a provider response until /capture/end makes that boundary
	// explicit.
	b.mu.Unlock()
}

func (b *missionControlScopedBridge) emitPrefixLocked(capture *missionControlCapture, kind string) {
	if capture.phase != "committed" && !(capture.phase == "response" && capture.replyText != "") {
		return
	}
	capture.prefixNonce = uuid.New().String()
	capture.phase = "prefix"
	b.attachment.emitLocked("prefix_request", capture.prefixNonce, kind, capture.grant.CaptureID,
		"About "+boundedThreadVoiceLabel(b.runtime.Thread)+".")
	if b.attachment.onPrefixTimeout != nil {
		nonce := capture.prefixNonce
		go func() {
			timer := time.NewTimer(30 * time.Second)
			defer timer.Stop()
			<-timer.C
			b.attachment.onPrefixTimeout(nonce)
		}()
	}
}

func (b *missionControlScopedBridge) emitRoutePrefixLocked() {
	b.attachment.prefixNonce = uuid.New().String()
	b.attachment.prefixKind, b.attachment.prefixCaptureID = "route", ""
	b.attachment.emitLocked("prefix_request", b.attachment.prefixNonce, "route", "",
		"Operator, now talking in "+boundedThreadVoiceLabel(b.runtime.Thread)+".")
	if b.attachment.onPrefixTimeout != nil {
		nonce := b.attachment.prefixNonce
		go func() {
			timer := time.NewTimer(30 * time.Second)
			defer timer.Stop()
			<-timer.C
			b.attachment.onPrefixTimeout(nonce)
		}()
	}
}

func boundedVoiceLabel(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == 0x202a || r == 0x202b || r == 0x202d || r == 0x202e || r == 0x2066 || r == 0x2067 || r == 0x2068 || r == 0x2069 {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if value == "" {
		return "Mission Control"
	}
	if len(value) > 80 {
		return value[:80]
	}
	return value
}

func boundedThreadVoiceLabel(thread missioncontrol.Thread) string {
	if thread.Kind == "lobby" {
		return "the read-only Lobby"
	}
	name := boundedVoiceLabel(thread.DisplayName)
	machine := boundedVoiceLabel(thread.MachineID)
	workspace := boundedVoiceLabel(thread.WorkspaceUUID)
	if len(machine) > 8 {
		machine = machine[:8]
	}
	if len(workspace) > 8 {
		workspace = workspace[:8]
	}
	return name + " on machine " + machine + ", workspace " + workspace
}

func (a *missionControlVoiceAttachment) emitLocked(typ, nonce, kind, captureID, message string) {
	a.nextEvent++
	event := missionControlVoiceEvent{
		Cursor: a.nextEvent, Type: typ, Nonce: nonce, Kind: kind, CaptureID: captureID,
		AttachmentEpoch: a.attachmentEpoch, FocusEpoch: a.focusEpoch, Message: message,
	}
	a.events = append(a.events, event)
	if len(a.events) > 32 {
		a.events = a.events[len(a.events)-32:]
	}
	select {
	case a.eventWake <- struct{}{}:
	default:
	}
}

func (a *missionControlVoiceAttachment) eventsAfterLocked(cursor uint64) ([]missionControlVoiceEvent, bool) {
	if len(a.events) == 0 {
		return nil, false
	}
	if cursor != 0 && cursor < a.events[0].Cursor-1 {
		return nil, true
	}
	out := make([]missionControlVoiceEvent, 0, len(a.events))
	for _, event := range a.events {
		if event.Cursor > cursor {
			out = append(out, event)
		}
	}
	return out, false
}

func (a *missionControlVoiceAttachment) settleCapture(grant voice.CaptureGrant) {
	a.bridge.mu.Lock()
	if a.capture == nil || a.capture.grant != grant {
		a.bridge.mu.Unlock()
		return
	}
	a.capture.phase = "settled"
	a.capture = nil
	a.bridge.mu.Unlock()
	if a.onCaptureSettled != nil {
		a.onCaptureSettled(grant)
	}
}

// startDeliveryWait admits attachment-owned delivery observation before
// shutdown can join it. TurnHandle.Wait cancellation stops only the wait, not
// the admitted Mission Control work.
func (a *missionControlVoiceAttachment) startDeliveryWait(work func(context.Context)) bool {
	a.deliveryMu.Lock()
	if a.deliveryClosed {
		a.deliveryMu.Unlock()
		return false
	}
	a.deliveryWG.Add(1)
	ctx := a.deliveryCtx
	a.deliveryMu.Unlock()
	go func() {
		defer a.deliveryWG.Done()
		work(ctx)
	}()
	return true
}

func (a *missionControlVoiceAttachment) stopDeliveryWaits() {
	a.deliveryMu.Lock()
	if a.deliveryClosed {
		a.deliveryMu.Unlock()
		return
	}
	a.deliveryClosed = true
	a.deliveryCancel()
	a.deliveryMu.Unlock()
	a.deliveryWG.Wait()
}

type voiceTurnHandle struct{ turn *cos.Turn }

func (t *voiceTurnHandle) ID() string { return t.turn.ID }

func (t *voiceTurnHandle) Wait(ctx context.Context) (string, error) {
	event, err := t.turn.Wait(ctx)
	if err != nil {
		return "", err
	}
	if event.Ev == cos.EvError || event.Ev == cos.EvCancelled || event.Ev == cos.EvTurnCancelled {
		if event.Message != "" {
			return "", errors.New(event.Message)
		}
		if event.Code != "" {
			return "", errors.New(event.Code)
		}
		return "", errors.New("Mission Control turn ended without an answer")
	}
	return event.Response, nil
}

// registerMissionControlVoiceRoutes installs the candidate attachment API only
// when the separate gate and a valid configured provider are both present.
// Lease protocol remains useful for deterministic HTTP fencing evidence even
// when candidate attachment is disabled.
func (s *Server) registerMissionControlVoiceRoutes(cfg config.VoiceConfig, protect func(http.Handler) http.Handler) {
	// registerVoiceRoutes runs during Server construction. State is owned by
	// this Server and is cleared from its shutdown path; it is never retained
	// in a process-global map keyed by dead server pointers.
	s.missionControlVoice = voice.NewLeaseManager()
	s.hub.mu.Lock()
	s.hub.missionControlVoiceBusy = s.missionControlVoiceThreadBusy
	s.hub.mu.Unlock()
	s.mux.Handle("GET /api/missioncontrol/voice/capabilities", protect(http.HandlerFunc(s.handleMissionControlVoiceCapabilities)))
	s.mux.Handle("POST /api/missioncontrol/voice/lease", protect(http.HandlerFunc(s.handleMissionControlVoiceLease)))
	s.mux.Handle("POST /api/missioncontrol/voice/heartbeat", protect(http.HandlerFunc(s.handleMissionControlVoiceHeartbeat)))
	s.mux.Handle("POST /api/missioncontrol/voice/focus", protect(http.HandlerFunc(s.handleMissionControlVoiceFocus)))
	s.mux.Handle("POST /api/missioncontrol/voice/capture", protect(http.HandlerFunc(s.handleMissionControlVoiceCapture)))
	s.mux.Handle("POST /api/missioncontrol/voice/capture/begin", protect(http.HandlerFunc(s.handleMissionControlVoiceCaptureBegin)))
	s.mux.Handle("POST /api/missioncontrol/voice/capture/end", protect(http.HandlerFunc(s.handleMissionControlVoiceCaptureEnd)))
	s.mux.Handle("POST /api/missioncontrol/voice/prefix/ack", protect(http.HandlerFunc(s.handleMissionControlVoicePrefixAck)))
	s.mux.Handle("POST /api/missioncontrol/voice/drain/ack", protect(http.HandlerFunc(s.handleMissionControlVoiceDrainAck)))
	s.mux.Handle("POST /api/missioncontrol/voice/events", protect(http.HandlerFunc(s.handleMissionControlVoiceEvents)))
	s.mux.Handle("POST /api/missioncontrol/voice/stop", protect(http.HandlerFunc(s.handleMissionControlVoiceStop)))
	s.mux.Handle("POST /api/missioncontrol/voice/attachment/token", protect(http.HandlerFunc(s.handleMissionControlVoiceAttachmentToken)))
	s.mux.Handle("POST /api/missioncontrol/voice/attachment/sdp", protect(http.HandlerFunc(s.handleMissionControlVoiceAttachmentSDP)))
	s.mux.Handle("POST /api/missioncontrol/voice/attachment/abort", protect(http.HandlerFunc(s.handleMissionControlVoiceAttachmentAbort)))
	if s.cfg.MissionControl.VoicePreview && cfg.Enabled {
		if mgr, err := voice.NewManager(cfg, missionControlDisabledBridge{}, voice.DefaultKeyPath()); err == nil {
			s.missionControlVoiceProvider = mgr
		}
	}
}

type missionControlDisabledBridge struct{}

func (missionControlDisabledBridge) Submit(string) (voice.TurnHandle, error) {
	return nil, errors.New("voice: legacy bridge is disabled for Mission Control")
}
func (missionControlDisabledBridge) Approve(string, bool, string) error {
	return errors.New("voice: legacy bridge is disabled for Mission Control")
}
func (missionControlDisabledBridge) Cancel(string) error {
	return errors.New("voice: legacy bridge is disabled for Mission Control")
}

func (s *Server) handleMissionControlVoiceCapabilities(w http.ResponseWriter, r *http.Request) {
	if v := r.URL.Query().Get("protocol_version"); v != "" && v != "3" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_protocol_unsupported", "Mission Control voice requires protocol_version=3")
		return
	}
	if v := r.Header.Get("X-MissionControl-Voice-Protocol"); v != "" && v != "3" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_protocol_unsupported", "Mission Control voice requires protocol_version=3")
		return
	}
	if _, err := s.hub.missionControlCatalog(); err != nil {
		writeMissionControlVoiceJSON(w, http.StatusConflict, map[string]any{
			"ok": false, "surface": "Mission Control", "owner_label": "Operator/Tank",
			"capabilities": map[string]bool{
				"thread_voice_default_off": true, "lease_negotiation": false,
				"focus_fencing": false, "capture_fencing": false,
				"provider_attachment": false, "microphone_admission": false,
			},
			"code": "text_runtime_unavailable", "error": err.Error(),
		})
		return
	}
	if _, err := s.hub.missionControlRouterForText(); err != nil {
		writeMissionControlVoiceJSON(w, http.StatusConflict, map[string]any{
			"ok": false, "surface": "Mission Control", "owner_label": "Operator/Tank",
			"capabilities": map[string]bool{
				"thread_voice_default_off": true, "lease_negotiation": false,
				"focus_fencing": false, "capture_fencing": false,
				"provider_attachment": false, "microphone_admission": false,
			},
			"code": "text_runtime_unavailable", "error": err.Error(),
		})
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"protocol_version": missionControlVoiceProtocolVersion,
		"surface":          "Mission Control",
		"owner_label":      "Operator/Tank",
		"capabilities": map[string]any{
			"thread_voice_default_off":           true,
			"voice_enabled":                      false,
			"voice_preview_configured":           s.missionControlVoiceProvider != nil,
			"lease_protocol_available":           true,
			"lease_negotiation":                  false,
			"focus_fencing":                      true,
			"capture_fencing":                    true,
			"capture_protocol_available":         true,
			"prefix_protocol_available":          true,
			"drain_protocol_available":           true,
			"experimental_voice_candidate_ready": s.missionControlVoiceProvider != nil,
			"single_active_bridge_verified":      false,
			"explicit_takeover":                  false,
			"provider_attachment":                s.missionControlVoiceProvider != nil,
			"microphone_admission":               false,
			"spoken_prefix_audio":                false,
			"provider_input_event_mapping":       true,
			"provider_sink_stop_drain_ack":       true,
			"work_cancellation_on_audio_stop":    false,
		},
		"implementation_status": map[string]string{
			"lease_protocol":               "implemented; session ownership not verified",
			"provider_attachment":          missionControlVoiceAttachmentStatus(s.missionControlVoiceProvider != nil),
			"provider_event_mapping":       "implemented protocol; provider event wire shape remains fixture verification required",
			"provider_sink_stop_drain_ack": "implemented protocol; provider event wire shape remains fixture verification required",
			"spoken_prefix_audio":          "backend nonce protocol implemented; browser local speech sink is not implemented",
		},
		"refusal": "microphone admission remains disabled until the browser performs the route-prefix, capture, answer-prefix, and local drain acknowledgement sequence against this protocol",
	})
}

func (s *Server) handleMissionControlVoiceLease(w http.ResponseWriter, r *http.Request) {
	req, c, ok := s.missionControlVoiceRequest(w, r)
	if !ok {
		return
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	grant, err := s.missionControlVoiceManager().Claim(c, bridgeID, controlToken, req.Takeover)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	body := map[string]any{"ok": true, "lease": grant.Lease}
	if grant.Issued {
		s.setMissionControlVoiceOwnerCookie(w, grant.BridgeID)
		// The capability is intentionally response-only: it is retained by
		// one tab and must be supplied in a header, while the browser-shared
		// HttpOnly cookie alone cannot control the lease.
		body["control_token"] = grant.ControlToken
	}
	writeMissionControlVoiceJSON(w, http.StatusCreated, body)
}

// handleMissionControlVoiceAttachmentToken reserves one attachment candidate
// before minting. The candidate is bounded by the lease manager and is aborted
// on every mint failure; it cannot move the selected text target.
func (s *Server) handleMissionControlVoiceAttachmentToken(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	if s.missionControlVoiceProvider == nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_preview_disabled", "Mission Control voice preview is disabled or its provider configuration is unavailable")
		return
	}
	attachmentEpoch, err := s.missionControlVoiceManager().BeginAttachment(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	catalog, err := s.hub.missionControlCatalog()
	if err != nil {
		s.missionControlVoiceManager().AbortAttachment(c, bridgeID, controlToken, req.LeaseEpoch, attachmentEpoch)
		writeMissionControlVoiceFailure(w, http.StatusConflict, "catalog_unavailable", err.Error())
		return
	}
	router, err := s.hub.missionControlRouterForText()
	runtime := (*missioncontrol.Runtime)(nil)
	if err == nil {
		runtime = router.Runtime(c.ThreadID)
	}
	if err != nil || runtime == nil {
		s.missionControlVoiceManager().AbortAttachment(c, bridgeID, controlToken, req.LeaseEpoch, attachmentEpoch)
		writeMissionControlVoiceFailure(w, http.StatusConflict, "runtime_unavailable", "selected Mission Control runtime is no longer live")
		return
	}
	bridge := &missionControlScopedBridge{
		correlation: c, attachmentEpoch: attachmentEpoch, catalog: catalog, runtime: runtime,
		validate: func() error { return s.validateMissionControlVoiceCorrelation(c) },
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	eph, err := s.missionControlVoiceProvider.MintScoped(ctx, bridge)
	if err != nil {
		s.missionControlVoiceManager().AbortAttachment(c, bridgeID, controlToken, req.LeaseEpoch, attachmentEpoch)
		writeMissionControlVoiceFailure(w, http.StatusBadGateway, "provider_mint_failed", err.Error())
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	if s.missionControlVoiceAttachment != nil {
		s.missionControlVoiceAttachmentMu.Unlock()
		s.missionControlVoiceProvider.End(eph.SessionID)
		s.missionControlVoiceManager().AbortAttachment(c, bridgeID, controlToken, req.LeaseEpoch, attachmentEpoch)
		writeMissionControlVoiceFailure(w, http.StatusConflict, "attachment_candidate_active", "a Mission Control provider attachment candidate already exists")
		return
	}
	deliveryCtx, deliveryCancel := context.WithCancel(context.Background())
	s.missionControlVoiceAttachment = &missionControlVoiceAttachment{
		correlation: c, leaseEpoch: req.LeaseEpoch, focusEpoch: req.FocusEpoch,
		attachmentEpoch: attachmentEpoch, bridgeID: bridgeID, controlToken: controlToken,
		sessionID: eph.SessionID, bridge: bridge,
		eventWake: make(chan struct{}, 1), inputIDs: make(map[string]struct{}),
		deliveryCtx: deliveryCtx, deliveryCancel: deliveryCancel,
	}
	bridge.attachment = s.missionControlVoiceAttachment
	s.missionControlVoiceAttachment.onCaptureSettled = func(grant voice.CaptureGrant) {
		s.missionControlVoiceManager().SettleCapture(c, bridgeID, controlToken, req.LeaseEpoch, attachmentEpoch, grant)
	}
	candidate := s.missionControlVoiceAttachment
	candidate.onDrainReady = func() {
		s.completeMissionControlVoiceDrain(candidate)
	}
	candidate.onPrefixTimeout = func(nonce string) {
		candidate.bridge.mu.Lock()
		kind, captureID := candidate.prefixKind, candidate.prefixCaptureID
		route := kind == "route" && !candidate.routeAnnounced && candidate.prefixNonce == nonce
		answer := candidate.capture != nil && candidate.capture.phase == "prefix" && candidate.capture.prefixNonce == nonce
		if !route && !answer {
			candidate.bridge.mu.Unlock()
			return
		}
		if answer {
			kind, captureID = "answer", candidate.capture.grant.CaptureID
		}
		candidate.emitLocked("prefix_timeout", nonce, kind, captureID, "Prefix acknowledgement timed out; attachment remains muted.")
		sideband := candidate.sideband
		candidate.bridge.mu.Unlock()
		if sideband != nil {
			sideband.Fence("prefix acknowledgement timed out")
		}
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	go s.expireMissionControlVoiceCandidate(candidate)
	writeMissionControlVoiceJSON(w, http.StatusCreated, map[string]any{
		"ok": true, "session_id": eph.SessionID,
		"expires_at": eph.ExpiresAt, "attachment_epoch": attachmentEpoch,
		"microphone_admission": false,
		"message":              "Provider attachment candidate created; microphone and response admission remain muted pending deterministic local prefix and drain acknowledgements.",
	})
}

type missionControlVoiceSDPRequest struct {
	missionControlVoiceRequest
	SessionID       string `json:"session_id"`
	AttachmentEpoch uint64 `json:"attachment_epoch"`
	SDP             string `json:"sdp"`
}

func (s *Server) handleMissionControlVoiceAttachmentSDP(w http.ResponseWriter, r *http.Request) {
	if !s.missionControlVoiceSameOrigin(w, r) {
		return
	}
	var req missionControlVoiceSDPRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxOfferBytes)).Decode(&req); err != nil || strings.TrimSpace(req.SDP) == "" {
		writeMissionControlVoiceFailure(w, http.StatusBadRequest, "bad_request", "attachment SDP requires bounded JSON correlation and a non-empty SDP offer")
		return
	}
	if req.ProtocolVersion != missionControlVoiceProtocolVersion {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_protocol_unsupported", "Mission Control voice requires protocol_version=3")
		return
	}
	c := voice.VoiceCorrelation{
		ThreadID: req.ThreadID, RuntimeSessionID: req.RuntimeSessionID,
		RuntimeGeneration: req.RuntimeGeneration, RuntimeIncarnation: req.RuntimeIncarnation,
	}
	if err := s.validateMissionControlVoiceCorrelation(c); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_thread_runtime", err.Error())
		return
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	if bridgeID == "" || controlToken == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "bridge_capability_required", "attachment SDP requires the issued bridge cookie and per-tab control_token")
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	attachment := s.missionControlVoiceAttachment
	matches := attachment != nil && attachment.correlation == c && attachment.leaseEpoch == req.LeaseEpoch &&
		attachment.attachmentEpoch == req.AttachmentEpoch && attachment.sessionID == req.SessionID &&
		attachment.bridgeID == bridgeID && attachment.controlToken == controlToken
	if matches && (attachment.connecting || attachment.committed) {
		s.missionControlVoiceAttachmentMu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "attachment_already_used", "this candidate already owns an SDP exchange")
		return
	}
	if matches {
		attachment.connecting = true
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	if !matches {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment", "attachment SDP does not name the current immutable candidate")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 50*time.Second)
	defer cancel()
	answer, sideband, err := s.missionControlVoiceProvider.ConnectScoped(ctx, req.SessionID, req.SDP)
	if err != nil {
		s.clearMissionControlVoiceCandidate(attachment)
		writeMissionControlVoiceFailure(w, http.StatusBadGateway, "provider_sdp_failed", err.Error())
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	if s.missionControlVoiceAttachment != attachment || !attachment.connecting || attachment.committed {
		s.missionControlVoiceAttachmentMu.Unlock()
		s.missionControlVoiceProvider.End(req.SessionID)
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment", "candidate ownership ended during SDP exchange")
		return
	}
	attachment.bridge.mu.Lock()
	if attachment.failed {
		attachment.bridge.mu.Unlock()
		s.missionControlVoiceAttachmentMu.Unlock()
		s.missionControlVoiceProvider.End(req.SessionID)
		s.clearMissionControlVoiceCandidate(attachment)
		writeMissionControlVoiceFailure(w, http.StatusConflict, "attachment_failed", "provider sideband ended before attachment publication")
		return
	}
	lease, err := s.missionControlVoiceManager().CommitAttachment(c, bridgeID, controlToken, req.LeaseEpoch, req.AttachmentEpoch)
	if err != nil {
		attachment.bridge.mu.Unlock()
		s.missionControlVoiceAttachmentMu.Unlock()
		s.missionControlVoiceProvider.End(req.SessionID)
		s.clearMissionControlVoiceCandidate(attachment)
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	attachment.committed = true
	attachment.sideband = sideband
	attachment.bridge.emitRoutePrefixLocked()
	attachment.bridge.mu.Unlock()
	s.missionControlVoiceAttachmentMu.Unlock()
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{
		"ok": true, "sdp": answer.SDP, "attachment_epoch": lease.AttachmentEpoch,
		"provider_call_id": answer.CallID, "microphone_admission": false,
		"message": "Provider attachment is server-scoped and muted. Complete the emitted route prefix handshake before reserving capture.",
	})
}

func (s *Server) handleMissionControlVoiceAttachmentAbort(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceCleanupRequest(w, r)
	if !ok {
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	candidate := s.missionControlVoiceAttachment
	if candidate == nil || candidate.committed || candidate.correlation != c ||
		candidate.leaseEpoch != req.LeaseEpoch || candidate.attachmentEpoch != req.AttachmentEpoch ||
		candidate.sessionID != req.SessionID || candidate.bridgeID != bridgeID || candidate.controlToken != controlToken {
		s.missionControlVoiceAttachmentMu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment_candidate", "abort names no current uncommitted attachment candidate")
		return
	}
	s.missionControlVoiceAttachment = nil
	s.missionControlVoiceAttachmentMu.Unlock()
	candidate.stopDeliveryWaits()
	if s.missionControlVoiceProvider != nil {
		s.missionControlVoiceProvider.End(candidate.sessionID)
	}
	s.missionControlVoiceManager().AbortAttachment(c, bridgeID, controlToken, req.LeaseEpoch, req.AttachmentEpoch)
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "session_id": req.SessionID, "attachment_epoch": req.AttachmentEpoch, "microphone_admission": false})
}

func (s *Server) clearMissionControlVoiceCandidate(candidate *missionControlVoiceAttachment) {
	if candidate == nil {
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	if s.missionControlVoiceAttachment == candidate {
		s.missionControlVoiceAttachment = nil
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	candidate.stopDeliveryWaits()
	s.missionControlVoiceManager().AbortAttachment(candidate.correlation, candidate.bridgeID, candidate.controlToken, candidate.leaseEpoch, candidate.attachmentEpoch)
}

func (s *Server) missionControlVoiceAttachmentFor(c voice.VoiceCorrelation, leaseEpoch, attachmentEpoch uint64, bridgeID, controlToken string) (*missionControlVoiceAttachment, bool) {
	s.missionControlVoiceAttachmentMu.Lock()
	defer s.missionControlVoiceAttachmentMu.Unlock()
	attachment := s.missionControlVoiceAttachment
	if attachment == nil || !attachment.committed || attachment.correlation != c ||
		attachment.leaseEpoch != leaseEpoch || attachment.attachmentEpoch != attachmentEpoch ||
		attachment.bridgeID != bridgeID || attachment.controlToken != controlToken {
		return nil, false
	}
	return attachment, true
}

func (s *Server) missionControlVoiceAttachmentForCleanup(c voice.VoiceCorrelation, leaseEpoch, attachmentEpoch uint64, bridgeID, controlToken string) (*missionControlVoiceAttachment, bool) {
	s.missionControlVoiceAttachmentMu.Lock()
	defer s.missionControlVoiceAttachmentMu.Unlock()
	attachment := s.missionControlVoiceAttachment
	if attachment == nil || attachment.correlation != c || attachment.leaseEpoch != leaseEpoch ||
		attachment.attachmentEpoch != attachmentEpoch || attachment.bridgeID != bridgeID || attachment.controlToken != controlToken {
		return nil, false
	}
	return attachment, true
}

func (s *Server) completeMissionControlVoiceDrain(attachment *missionControlVoiceAttachment) {
	if attachment == nil {
		return
	}
	attachment.bridge.mu.Lock()
	if !attachment.draining || !attachment.providerCleared || !attachment.providerTerminal || !attachment.clientDrained {
		attachment.bridge.mu.Unlock()
		return
	}
	attachment.draining = false
	attachment.emitLocked("drain_complete", attachment.drainNonce, "route", "", "Provider cancellation/clear and authenticated browser drain were observed.")
	attachment.bridge.mu.Unlock()
	if s.missionControlVoiceManager().CompleteDrain(attachment.correlation, attachment.bridgeID, attachment.controlToken, attachment.leaseEpoch) != nil {
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	if s.missionControlVoiceAttachment == attachment {
		s.missionControlVoiceAttachment = nil
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	attachment.stopDeliveryWaits()
	if s.missionControlVoiceProvider != nil {
		s.missionControlVoiceProvider.End(attachment.sessionID)
	}
}

func (s *Server) expireMissionControlVoiceCandidate(candidate *missionControlVoiceAttachment) {
	timer := time.NewTimer(missionControlVoiceCandidateTTL)
	defer timer.Stop()
	<-timer.C
	s.missionControlVoiceAttachmentMu.Lock()
	if s.missionControlVoiceAttachment != candidate || candidate.committed {
		s.missionControlVoiceAttachmentMu.Unlock()
		return
	}
	s.missionControlVoiceAttachment = nil
	s.missionControlVoiceAttachmentMu.Unlock()
	candidate.stopDeliveryWaits()
	if s.missionControlVoiceProvider != nil {
		s.missionControlVoiceProvider.End(candidate.sessionID)
	}
	s.missionControlVoiceManager().AbortAttachment(candidate.correlation, candidate.bridgeID, candidate.controlToken, candidate.leaseEpoch, candidate.attachmentEpoch)
}

func (s *Server) handleMissionControlVoiceHeartbeat(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	lease, err := s.missionControlVoiceManager().Heartbeat(c, bridgeID, controlToken, req.LeaseEpoch)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "lease": lease})
}

func (s *Server) handleMissionControlVoiceFocus(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	attachment, attached := s.missionControlVoiceAttachmentFor(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if attached {
		attachment.bridge.mu.Lock()
		busy := attachment.capture != nil || attachment.draining
		attachment.bridge.mu.Unlock()
		if busy {
			writeMissionControlVoiceFailure(w, http.StatusConflict, "focus_busy", "focus cannot change while capture or drain is active")
			return
		}
	}
	lease, err := s.missionControlVoiceManager().Focus(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	if attached {
		attachment.bridge.mu.Lock()
		attachment.focusEpoch = lease.FocusEpoch
		attachment.routeAnnounced = false
		attachment.bridge.emitRoutePrefixLocked()
		attachment.bridge.mu.Unlock()
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "lease": lease})
}

func (s *Server) handleMissionControlVoiceCapture(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	if err := s.missionControlVoiceManager().CaptureGate(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch, req.CaptureEpoch); err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "media_admission": false})
}

func (s *Server) handleMissionControlVoiceCaptureBegin(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	attachment, ok := s.missionControlVoiceAttachmentFor(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if !ok {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment", "capture does not name the current immutable attachment")
		return
	}
	attachment.bridge.mu.Lock()
	if !attachment.routeAnnounced || attachment.sideband == nil {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "route_prefix_required", "capture remains muted until the route prefix is acknowledged and the attachment sideband is usable")
		return
	}
	if attachment.capture != nil {
		// A retry that carries the exact server-issued capture identity is
		// idempotent. A different/empty identity never replaces the winner.
		capture := attachment.capture
		if req.CaptureID == capture.grant.CaptureID && req.CaptureEpoch == capture.grant.CaptureEpoch {
			attachment.bridge.mu.Unlock()
			writeMissionControlVoiceJSON(w, http.StatusCreated, map[string]any{
				"ok": true, "capture_id": capture.grant.CaptureID, "capture_epoch": capture.grant.CaptureEpoch,
				"attachment_epoch": req.AttachmentEpoch, "media_enabled": false, "media_admission": true,
				"message": "Capture is already reserved for this announced attachment.",
			})
			return
		}
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "capture_active", "an attachment capture is already unsettled")
		return
	}
	// Make lease grant and attachment publication indivisible. Thus no
	// post-grant conflict path can accidentally settle the winning capture.
	grant, err := s.missionControlVoiceManager().BeginCapture(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch, req.AttachmentEpoch)
	if err != nil {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	attachment.capture = &missionControlCapture{grant: grant, phase: "reserved", outputCalls: make(map[string]string)}
	attachment.bridge.mu.Unlock()
	writeMissionControlVoiceJSON(w, http.StatusCreated, map[string]any{
		"ok": true, "capture_id": grant.CaptureID, "capture_epoch": grant.CaptureEpoch,
		"attachment_epoch": req.AttachmentEpoch, "media_enabled": false, "media_admission": true,
		"message": "Capture is reserved for this announced attachment. Media may be enabled only after this response; end capture before a provider response can be requested.",
	})
}

func (s *Server) handleMissionControlVoiceCaptureEnd(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	attachment, ok := s.missionControlVoiceAttachmentFor(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if !ok {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment", "capture end does not name the current immutable attachment")
		return
	}
	attachment.bridge.mu.Lock()
	capture := attachment.capture
	if capture == nil || capture.grant.CaptureID != req.CaptureID || capture.grant.CaptureEpoch != req.CaptureEpoch || capture.phase != "reserved" && capture.phase != "committed" {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_capture", "capture end does not name the one reserved capture")
		return
	}
	if err := s.missionControlVoiceManager().EndCapture(c, bridgeID, controlToken, req.LeaseEpoch, req.AttachmentEpoch, capture.grant); err != nil {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	if capture.phase == "reserved" {
		capture.phase = "ended"
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "state": "ended", "message": "Capture ended; awaiting a provider input commit for this reservation."})
		return
	}
	attachment.bridge.emitPrefixLocked(capture, "answer")
	attachment.bridge.mu.Unlock()
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "state": "prefix_pending"})
}

func (s *Server) handleMissionControlVoicePrefixAck(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	attachment, ok := s.missionControlVoiceAttachmentFor(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if !ok || req.PrefixNonce == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_prefix", "prefix acknowledgement does not name the current attachment focus and nonce")
		return
	}
	if err := s.missionControlVoiceManager().ValidateAttachment(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch, req.AttachmentEpoch); err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	attachment.bridge.mu.Lock()
	if req.FocusEpoch != attachment.focusEpoch {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_prefix", "attachment focus changed")
		return
	}
	routePrefix := attachment.prefixNonce == req.PrefixNonce && attachment.prefixKind == "route"
	attachment.bridge.mu.Unlock()
	if err := attachment.bridge.PrefixAcknowledged(req.PrefixNonce); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "prefix_refused", err.Error())
		return
	}
	if routePrefix {
		writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "state": "route_announced", "media_admission": true})
		return
	}
	attachment.bridge.mu.Lock()
	mediaAdmission := attachment.routeAnnounced && !attachment.failed && !attachment.draining
	attachment.bridge.mu.Unlock()
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "state": "response_requested", "media_admission": mediaAdmission})
}

// handleMissionControlVoiceEvents is a bounded owner-only long poll. It gives
// the browser deterministic prefix/drain notices without placing a capability
// in a URL or broadcasting voice control to another tab.
func (s *Server) handleMissionControlVoiceEvents(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	attachment, ok := s.missionControlVoiceAttachmentFor(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if !ok {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_attachment", "event poll does not name the current immutable attachment")
		return
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	for {
		attachment.bridge.mu.Lock()
		events, gap := attachment.eventsAfterLocked(req.Cursor)
		attachment.bridge.mu.Unlock()
		if gap {
			writeMissionControlVoiceFailure(w, http.StatusConflict, "event_gap", "voice attachment event cursor is too old; do not infer a missed prefix or drain acknowledgement")
			return
		}
		if len(events) > 0 {
			writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "events": events, "cursor": events[len(events)-1].Cursor})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "events": []missionControlVoiceEvent{}, "cursor": req.Cursor})
			return
		case <-attachment.eventWake:
		}
	}
}

func (s *Server) handleMissionControlVoiceStop(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceCleanupRequest(w, r)
	if !ok {
		return
	}
	s.missionControlVoiceAttachmentMu.Lock()
	attachment := s.missionControlVoiceAttachment
	if attachment != nil && attachment.correlation == c && attachment.leaseEpoch == req.LeaseEpoch && attachment.attachmentEpoch == req.AttachmentEpoch &&
		attachment.bridgeID == bridgeID && attachment.controlToken == controlToken {
	} else {
		attachment = nil
	}
	s.missionControlVoiceAttachmentMu.Unlock()
	if attachment == nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "attachment_unavailable", "safe drain requires the original attachment record")
		return
	}
	if err := s.missionControlVoiceManager().BeginDrain(c, bridgeID, controlToken, req.LeaseEpoch); err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	attachment.bridge.mu.Lock()
	attachment.draining = true
	attachment.clientDrained = false
	attachment.providerCleared = false
	attachment.providerTerminal = attachment.capture == nil || attachment.capture.responseID == ""
	attachment.drainNonce = uuid.New().String()
	attachment.emitLocked("drain_request", attachment.drainNonce, "route", "", "Stop local tracks and audio graph, then acknowledge this drain nonce. Provider cancellation and output clear are also required.")
	sideband := attachment.sideband
	attachment.bridge.mu.Unlock()
	// Stop ends delivery observation, never the text turn that may already
	// have been admitted through SubmitCorrelated.
	attachment.stopDeliveryWaits()
	if sideband != nil {
		// Fence linearizes prefix ACK response.create against drain: an ACK that
		// acquired the scoped write gate first sends before this cancel/clear;
		// an ACK after this fence observes it and is refused.
		sideband.Fence("owner requested attachment drain")
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{
		"ok": true, "work_cancelled": false, "state": "draining",
		"message": "Mission Control voice drain started; text-thread work remains running. A replacement remains refused until provider and browser drain acknowledgements arrive.",
	})
}

func (s *Server) handleMissionControlVoiceDrainAck(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceCleanupRequest(w, r)
	if !ok {
		return
	}
	attachment, ok := s.missionControlVoiceAttachmentForCleanup(c, req.LeaseEpoch, req.AttachmentEpoch, bridgeID, controlToken)
	if !ok || req.DrainNonce == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_drain", "drain acknowledgement does not name the original attachment")
		return
	}
	attachment.bridge.mu.Lock()
	if !attachment.draining || attachment.drainNonce != req.DrainNonce {
		attachment.bridge.mu.Unlock()
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_drain", "drain acknowledgement nonce is stale")
		return
	}
	attachment.clientDrained = true
	complete := attachment.providerCleared && attachment.providerTerminal
	attachment.bridge.mu.Unlock()
	if complete {
		s.completeMissionControlVoiceDrain(attachment)
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "state": "draining", "provider_drain_observed": complete})
}

func (s *Server) missionControlVoiceOwnerRequest(w http.ResponseWriter, r *http.Request) (missionControlVoiceRequest, voice.VoiceCorrelation, string, string, bool) {
	req, c, ok := s.missionControlVoiceRequest(w, r)
	if !ok {
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, "", "", false
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	if bridgeID == "" || controlToken == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "bridge_capability_required", "claim a Mission Control voice lease and retain its per-tab control_token before controlling it")
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, "", "", false
	}
	return req, c, bridgeID, controlToken, true
}

func (s *Server) missionControlVoiceCleanupRequest(w http.ResponseWriter, r *http.Request) (missionControlVoiceRequest, voice.VoiceCorrelation, string, string, bool) {
	if !s.missionControlVoiceSameOrigin(w, r) {
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, "", "", false
	}
	var req missionControlVoiceRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusBadRequest, "bad_request", "invalid Mission Control voice cleanup request")
		return req, voice.VoiceCorrelation{}, "", "", false
	}
	if req.ProtocolVersion != missionControlVoiceProtocolVersion {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_protocol_unsupported", "Mission Control voice requires protocol_version=3")
		return req, voice.VoiceCorrelation{}, "", "", false
	}
	c := voice.VoiceCorrelation{ThreadID: req.ThreadID, RuntimeSessionID: req.RuntimeSessionID, RuntimeGeneration: req.RuntimeGeneration, RuntimeIncarnation: req.RuntimeIncarnation}
	if !validMissionControlRequestID(c.ThreadID) || !validMissionControlRequestID(c.RuntimeSessionID) || c.RuntimeGeneration == 0 || !validMissionControlRequestID(c.RuntimeIncarnation) {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_thread_runtime", "cleanup requires exact immutable thread/runtime correlation")
		return req, voice.VoiceCorrelation{}, "", "", false
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	if bridgeID == "" || controlToken == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "bridge_capability_required", "cleanup requires the original bridge cookie and tab control token")
		return req, voice.VoiceCorrelation{}, "", "", false
	}
	return req, c, bridgeID, controlToken, true
}

func (s *Server) missionControlVoiceRequest(w http.ResponseWriter, r *http.Request) (missionControlVoiceRequest, voice.VoiceCorrelation, bool) {
	if !s.missionControlVoiceSameOrigin(w, r) {
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, false
	}
	var req missionControlVoiceRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusBadRequest, "bad_request", "invalid Mission Control voice request")
		return req, voice.VoiceCorrelation{}, false
	}
	if req.ProtocolVersion != missionControlVoiceProtocolVersion {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "voice_protocol_unsupported", "Mission Control voice requires protocol_version=3")
		return req, voice.VoiceCorrelation{}, false
	}
	c := voice.VoiceCorrelation{
		ThreadID: req.ThreadID, RuntimeSessionID: req.RuntimeSessionID,
		RuntimeGeneration: req.RuntimeGeneration, RuntimeIncarnation: req.RuntimeIncarnation,
	}
	if err := s.validateMissionControlVoiceCorrelation(c); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_thread_runtime", err.Error())
		return req, voice.VoiceCorrelation{}, false
	}
	return req, c, true
}

func (s *Server) validateMissionControlVoiceCorrelation(c voice.VoiceCorrelation) error {
	if !validMissionControlRequestID(c.ThreadID) || !validMissionControlRequestID(c.RuntimeSessionID) ||
		c.RuntimeGeneration == 0 || !validMissionControlRequestID(c.RuntimeIncarnation) {
		return errors.New("thread_id, runtime_session_id, runtime_generation, and runtime_incarnation are required")
	}
	catalog, err := s.hub.missionControlCatalog()
	if err != nil {
		return err
	}
	thread, _, found, err := catalog.Thread(c.ThreadID)
	if err != nil || !found {
		return errors.New("Mission Control thread is unknown")
	}
	if thread.Lifecycle != "active" || thread.RuntimeSessionID != c.RuntimeSessionID ||
		thread.RuntimeGeneration != c.RuntimeGeneration || thread.RuntimeIncarnation != c.RuntimeIncarnation {
		return errors.New("Mission Control thread runtime is stale")
	}
	if thread.Kind != "lobby" {
		_, binding, bound, bindingErr := catalog.Thread(thread.ID)
		if bindingErr != nil || !bound || binding.ThreadID != thread.ID {
			return errors.New("voice target has no unambiguous workspace binding")
		}
		// Remote daemon sessions are browser-owned. This HTTP boundary must
		// not borrow another browser's transport or reinterpret it as local.
		if binding.HostID != "" {
			return errors.New("remote voice requires an authenticated remote identity seam; no local fallback was attempted")
		}
		if s.hub.dial == nil {
			return errors.New("local voice identity attestation is unavailable")
		}
		ctx, cancel := context.WithTimeout(context.Background(), sessiond.MissionControlReplyTimeout)
		defer cancel()
		daemon, dialErr := s.hub.dial(ctx, transport.HostRef{})
		if dialErr != nil {
			return errors.New("bound local daemon is unavailable")
		}
		defer func() { _ = daemon.Close() }()
		stopDeadline := context.AfterFunc(ctx, func() { _ = daemon.Close() })
		defer stopDeadline()
		identityClient, supported := daemon.(missionControlIdentityDaemon)
		if !supported {
			return errors.New("local daemon does not support voice identity attestation")
		}
		go func() { _ = daemon.Run() }()
		identity, identityErr := identityClient.MissionControlIdentity()
		if identityErr != nil || identity.MachineID != thread.MachineID ||
			identity.DaemonIncarnation != binding.DaemonIncarnation {
			return errors.New("bound local daemon identity or incarnation changed")
		}
		workspaces, listErr := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
		if listErr != nil {
			return errors.New("bound local workspace roster is unavailable")
		}
		live := false
		for _, workspace := range workspaces {
			if workspace.WorkspaceID == binding.LiveWorkspaceID && workspace.WorkspaceUUID == thread.WorkspaceUUID {
				live = true
				break
			}
		}
		if !live {
			return errors.New("bound workspace UUID is no longer live")
		}
	}
	router, err := s.hub.missionControlRouterForText()
	if err != nil {
		return errors.New("Mission Control text runtime is not live")
	}
	runtime := router.Runtime(c.ThreadID)
	if runtime == nil || runtime.Thread.ID != c.ThreadID ||
		runtime.Thread.RuntimeSessionID != c.RuntimeSessionID ||
		runtime.Thread.RuntimeGeneration != c.RuntimeGeneration ||
		runtime.Thread.RuntimeIncarnation != c.RuntimeIncarnation {
		return errors.New("Mission Control text runtime is not live")
	}
	return nil
}

func (s *Server) missionControlVoiceCredentials(r *http.Request) (string, string) {
	bridgeID := ""
	if cookie, err := r.Cookie(missionControlVoiceOwnerCookie); err == nil {
		bridgeID = cookie.Value
	}
	return bridgeID, strings.TrimSpace(r.Header.Get(missionControlVoiceControlHeader))
}

func (s *Server) setMissionControlVoiceOwnerCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		// Deliberately omit Path. Browsers derive it from the URL that issued
		// the cookie, retaining a reverse-proxy /t/{id}/ prefix rather than
		// widening the cookie to a root path that does not exist externally.
		Name: missionControlVoiceOwnerCookie, Value: token,
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteStrictMode,
		MaxAge: int(voice.MissionControlVoiceLeaseTTL.Seconds()),
	})
}

func (s *Server) missionControlVoiceManager() *voice.LeaseManager {
	return s.missionControlVoice
}

func (s *Server) missionControlVoiceThreadBusy(threadID string) bool {
	s.missionControlVoiceAttachmentMu.Lock()
	defer s.missionControlVoiceAttachmentMu.Unlock()
	attachment := s.missionControlVoiceAttachment
	return attachment != nil && attachment.correlation.ThreadID == threadID
}

// missionControlVoiceSameOrigin is stricter than the general protected-route
// wrapper because these routes mint a per-tab control capability. Browser POSTs
// must carry the configured public origin when proxied, or the direct request
// origin otherwise. A custom header capability then supplies the CSRF second
// factor: a cross-origin page cannot read the initial response or set the
// non-simple header without an allowed CORS preflight (none is provided).
func (s *Server) missionControlVoiceSameOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_required", "Mission Control voice control requests require an exact same-origin Origin header")
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_invalid", "Mission Control voice control origin is invalid")
		return false
	}
	expected := s.publicBaseURL()
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		host, port, err := net.SplitHostPort(s.addr)
		if err != nil || host == "" || port == "" {
			writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_unavailable", "Mission Control voice control cannot establish this server origin")
			return false
		}
		expected = scheme + "://" + net.JoinHostPort(host, port)
	}
	if !strings.EqualFold(origin, expected) {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_mismatch", "Mission Control voice control origin does not match this server")
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "cross_site_request", "Mission Control voice control requires a same-origin browser request")
		return false
	}
	return true
}

func missionControlVoiceAttachmentStatus(configured bool) string {
	if configured {
		return "implemented candidate: fresh scoped provider mint, SDP exchange, and sideband attach; microphone remains muted"
	}
	return "disabled: missioncontrol.voice_preview is false or [voice] is not enabled and valid"
}

func writeMissionControlVoiceLeaseError(w http.ResponseWriter, err error) {
	code := "lease_refused"
	switch {
	case errors.Is(err, voice.ErrBridgeActive):
		code = "bridge_active"
	case errors.Is(err, voice.ErrBridgeCapability):
		code = "bridge_capability_invalid"
	case errors.Is(err, voice.ErrLeaseFenced):
		code = "lease_fenced"
	case errors.Is(err, voice.ErrLeaseEpoch):
		code = "stale_lease_epoch"
	case errors.Is(err, voice.ErrFocusEpoch):
		code = "stale_focus_epoch"
	case errors.Is(err, voice.ErrCaptureEpoch):
		code = "stale_capture_epoch"
	case errors.Is(err, voice.ErrCaptureActive):
		code = "capture_active"
	case errors.Is(err, voice.ErrCaptureID):
		code = "stale_capture"
	case errors.Is(err, voice.ErrCorrelation):
		code = "stale_correlation"
	case errors.Is(err, voice.ErrBridgeSwitchUnsupported):
		code = "bridge_switch_unsupported"
	case errors.Is(err, voice.ErrTakeoverDrainUnsupported):
		code = "provider_sink_drain_ack_unsupported"
	case errors.Is(err, voice.ErrProviderEventMappingUnsupported):
		code = "provider_event_mapping_unsupported"
	case errors.Is(err, voice.ErrLeaseManagerClosed):
		code = "lease_manager_closed"
	}
	writeMissionControlVoiceFailure(w, http.StatusConflict, code, err.Error())
}

func writeMissionControlVoiceFailure(w http.ResponseWriter, status int, code, detail string) {
	writeMissionControlVoiceJSON(w, status, map[string]any{"ok": false, "code": code, "error": detail})
}

func writeMissionControlVoiceJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
