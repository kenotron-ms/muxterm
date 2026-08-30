package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Client represents a connected WebSocket client. Each browser WebSocket is
// backed by its own DaemonConn; the Client relays the frozen sessiond.Message
// vocabulary in both directions, holding no terminal state of its own.
//
// The cid carried on each message lives in two independent domains: the
// browser<->serve cid is owned by the browser and echoed back by serve, while
// the serve<->daemon cid is owned by the DaemonConn internally. serve never
// rewrites browser cids onto daemon requests.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex

	// daemon is the per-browser connection this client relays to. nil until the
	// hub attaches the client.
	daemon DaemonConn

	// recoveryMu protects recovery negotiation and the one bounded asynchronous
	// recovery request that can be in flight for this connection.
	// Daemon event handlers run on the daemon read loop, so they must not race a
	// successful hello updating the negotiated capability intersection.
	recoveryMu           sync.Mutex
	recoveryHello        recoveryHelloState
	recoveryCapabilities map[sessiond.RecoveryProtocolCapability]struct{}
	recoveryInFlight     *recoveryInFlight
	recoveryEvents       [recoveryPendingEventCapacity]recoveryPendingEvent
	recoveryEventCount   int

	// closeTickets retains browser-local target identity for opaque confirmation
	// tickets. It is touched only by this Client's readPump; the ticket remains
	// the sole daemon authorization input.
	closeTickets map[string]sessiond.CloseTarget

	// writeTextFn/writeBinaryFn perform the actual frame writes. Production
	// wires them to the real WebSocket writers in newClient; tests inject
	// capturing closures.
	writeTextFn   func([]byte) error
	writeBinaryFn func([]byte) error

	// wsMu guards workspaceID, the workspace this client is currently attached
	// to. It is set on a successful TypeAttach and read by daemon event relay
	// handlers (e.g. OnPaneAdded) that need to stamp WorkspaceID onto events
	// the daemon itself does not carry a workspace id on, since a client is
	// only ever attached to a single workspace at a time.
	wsMu        sync.Mutex
	workspaceID string

	// attachSeq enforces the frozen "composition FIRST" ordering guarantee
	// across the goroutine boundary between the daemon connection's read loop
	// (which delivers the composition reply via request/reply correlation on
	// one goroutine, then immediately continues its loop and dispatches the
	// following replay pane-data frames via OnPaneOutput on that SAME
	// goroutine) and this Client's own handleTextInput goroutine (which
	// receives the composition reply and must forward it to the browser/app
	// WebSocket). Without this lock, OnPaneOutput's writeBinary calls for
	// replay frames race ahead of handleTextInput's sendMessage(composition)
	// call and reach the wire first, since a buffered-channel handoff to the
	// pending request does not yield the daemon read-loop goroutine. Held by
	// handleTextInput for the full Attach()+sendMessage(composition) sequence,
	// and by OnPaneOutput around every binary relay, so pane-data can never be
	// written to the WebSocket while a composition send is in flight.
	attachSeq sync.Mutex
}

const (
	maxBrowserTextFrameBytes     = 1 << 20
	recoveryPendingEventCapacity = 16

	closeRelayFailureCode    = "close-relay-failed"
	closeRelayFailureMessage = "Close request could not be completed; try again."

	recoveryRelayFailureCode    = "recovery-relay-failed"
	recoveryRelayFailureMessage = "Recovery request could not be completed; try again."
)

// recoveryHelloState prevents duplicate negotiation attempts from changing a
// connection's recovery capability state.
type recoveryHelloState uint8

const (
	recoveryHelloNotStarted recoveryHelloState = iota
	recoveryHelloPending
	recoveryHelloDraining
	recoveryHelloReady
	recoveryHelloFailed
)

// recoveryRequestKind identifies the expected browser-safe result for the
// connection's sole in-flight recovery request. The daemon assigns its own CID
// behind DaemonConn; this state retains only the browser-owned CID.
type recoveryRequestKind uint8

const (
	recoveryRequestProtocolHello recoveryRequestKind = iota + 1
	recoveryRequestRetry
	recoveryRequestSelect
	recoveryRequestSetActivePane
)

type recoveryInFlight struct {
	cid  uint64
	kind recoveryRequestKind
}

// recoveryPendingEvent is an immutable, already-validated browser event held
// only across hello completion. Each payload is bounded by the frozen browser
// recovery message limit, and Client retains at most
// recoveryPendingEventCapacity entries.
type recoveryPendingEvent struct {
	messageType        string
	data               []byte
	compositionOrdered bool
}

// setWorkspaceID records the workspace this client is currently attached to.
func (c *Client) setWorkspaceID(id string) {
	c.wsMu.Lock()
	c.workspaceID = id
	c.wsMu.Unlock()
}

// getWorkspaceID returns the workspace this client is currently attached to,
// or "" if it has not attached yet.
func (c *Client) getWorkspaceID() string {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	return c.workspaceID
}

func validCloseTarget(target sessiond.CloseTarget) bool {
	if target.WorkspaceID == "" {
		return false
	}
	switch target.Kind {
	case sessiond.CloseTargetPane:
		return target.PaneID > 0
	case sessiond.CloseTargetWorkspace:
		return target.PaneID == 0
	default:
		return false
	}
}

func (c *Client) rememberCloseTicket(outcome sessiond.CloseOutcome) {
	target := sessiond.CloseTarget{
		Kind:        outcome.TargetKind,
		WorkspaceID: outcome.WorkspaceID,
		PaneID:      outcome.PaneID,
	}
	if outcome.Status != sessiond.CloseStatusConfirmationRequired ||
		outcome.Ticket == "" || !validCloseTarget(target) {
		return
	}

	if c.closeTickets == nil {
		c.closeTickets = make(map[string]sessiond.CloseTarget)
	}
	if _, exists := c.closeTickets[outcome.Ticket]; !exists &&
		len(c.closeTickets) >= sessiond.CloseTicketCapacity {
		for ticket := range c.closeTickets {
			delete(c.closeTickets, ticket)
			break
		}
	}
	c.closeTickets[outcome.Ticket] = target
}

func (c *Client) closeTargetForTicket(ticket string) (sessiond.CloseTarget, bool) {
	target, ok := c.closeTickets[ticket]
	return target, ok
}

func (c *Client) forgetCloseTicket(ticket string) {
	delete(c.closeTickets, ticket)
}

func closeOutcomeWithFallbackTarget(outcome sessiond.CloseOutcome, fallback sessiond.CloseTarget) sessiond.CloseOutcome {
	if outcome.TargetKind == "" && validCloseTarget(fallback) {
		outcome.TargetKind = fallback.Kind
		outcome.WorkspaceID = fallback.WorkspaceID
		outcome.PaneID = fallback.PaneID
	}
	return outcome
}

func closeRelayFailure(target sessiond.CloseTarget) sessiond.CloseOutcome {
	return sessiond.CloseOutcome{
		Status:      sessiond.CloseStatusFailed,
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
		FailureCode: closeRelayFailureCode,
		Error:       closeRelayFailureMessage,
	}
}

// newClient creates a new Client with a cancellable context and real WebSocket
// writers.
func newClient(hub *Hub, conn *websocket.Conn) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		hub:          hub,
		conn:         conn,
		ctx:          ctx,
		cancel:       cancel,
		closeTickets: make(map[string]sessiond.CloseTarget),
	}
	c.writeTextFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageText, data)
	}
	c.writeBinaryFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageBinary, data)
	}
	return c
}

// writeBinary writes a binary frame via the client's binary writer.
func (c *Client) writeBinary(data []byte) error { return c.writeBinaryFn(data) }

// writeText writes a text frame via the client's text writer.
func (c *Client) writeText(data []byte) error { return c.writeTextFn(data) }

// beginProtocolHello accepts exactly one hello attempt per connection. A
// pending silent legacy daemon therefore cannot accumulate recovery goroutines
// or block ordinary traffic on readPump.
func (c *Client) beginProtocolHello(cid uint64) bool {
	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()

	if c.recoveryHello != recoveryHelloNotStarted || c.recoveryInFlight != nil {
		return false
	}
	c.recoveryHello = recoveryHelloPending
	c.recoveryInFlight = &recoveryInFlight{cid: cid, kind: recoveryRequestProtocolHello}
	return true
}

// failProtocolHello marks the one allowed hello attempt as terminally
// unavailable without affecting the ordinary WebSocket protocol.
func (c *Client) failProtocolHello() {
	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()

	if c.recoveryHello == recoveryHelloPending ||
		c.recoveryHello == recoveryHelloDraining {
		c.recoveryHello = recoveryHelloFailed
		c.recoveryCapabilities = nil
		c.recoveryInFlight = nil
		c.clearPendingRecoveryEventsLocked()
	}
}

func (c *Client) clearPendingRecoveryEventsLocked() {
	for index := 0; index < c.recoveryEventCount; index++ {
		c.recoveryEvents[index] = recoveryPendingEvent{}
	}
	c.recoveryEventCount = 0
}

// beginRecoveryRequest reserves the single recovery-request slot. The
// connection read pump can continue processing ordinary traffic while the
// daemon call runs in its bounded one-request goroutine.
func (c *Client) beginRecoveryRequest(
	cid uint64,
	kind recoveryRequestKind,
	capability sessiond.RecoveryProtocolCapability,
) bool {
	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()

	_, supported := c.recoveryCapabilities[capability]
	if (c.recoveryHello != recoveryHelloDraining &&
		c.recoveryHello != recoveryHelloReady) ||
		!supported ||
		c.recoveryInFlight != nil {
		return false
	}
	c.recoveryInFlight = &recoveryInFlight{cid: cid, kind: kind}
	return true
}

// recoveryRequestCurrent checks that the asynchronous daemon result still
// belongs to the exact browser CID and operation that launched it.
func (c *Client) recoveryRequestCurrent(cid uint64, kind recoveryRequestKind) bool {
	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()

	return c.recoveryInFlight != nil &&
		c.recoveryInFlight.cid == cid &&
		c.recoveryInFlight.kind == kind
}

// finishRecoveryRequest releases the bounded slot only for its matching
// browser CID and operation.
func (c *Client) finishRecoveryRequest(cid uint64, kind recoveryRequestKind) bool {
	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()

	if c.recoveryInFlight == nil ||
		c.recoveryInFlight.cid != cid ||
		c.recoveryInFlight.kind != kind {
		return false
	}
	c.recoveryInFlight = nil
	return true
}

// protocolHelloResultMatchesOffer ensures the daemon's typed result cannot
// grant an unoffered capability or mark an incompatible schema as compatible.
// Both slices are bounded by the frozen recovery protocol.
func protocolHelloResultMatchesOffer(
	request sessiond.ProtocolHelloRequest,
	result sessiond.ProtocolHelloResult,
) bool {
	if result.Compatible && request.RecoverySchemaVersion != result.RecoverySchemaVersion {
		return false
	}
	for _, resultCapability := range result.Capabilities.Values {
		found := false
		for _, offeredCapability := range request.Capabilities.Values {
			if resultCapability == offeredCapability {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// isRecoverySensitiveMessageType recognizes every frozen browser-safe and
// owner-local recovery type before generic Message decoding.
func isRecoverySensitiveMessageType(messageType string) bool {
	switch messageType {
	case sessiond.TypeProtocolHello,
		sessiond.TypeProtocolHelloResult,
		sessiond.TypePaneRecoveryChanged,
		sessiond.TypeRecoveryRetry,
		sessiond.TypeRecoveryRetryResult,
		sessiond.TypeRecoverySelect,
		sessiond.TypeRecoverySelectResult,
		sessiond.TypeRecoveredHistory,
		sessiond.TypeLifecycleBootstrap,
		sessiond.TypeLifecycleBootstrapResult,
		sessiond.TypeLifecycleLeaseDelivery,
		sessiond.TypeLifecycleCapture,
		sessiond.TypeLifecycleCaptureOutcome,
		sessiond.TypeExplicitBind,
		sessiond.TypeExplicitBindResult,
		sessiond.TypeReplacementPlan,
		sessiond.TypeReplacementPlanResult,
		sessiond.TypeReplacementCommit,
		sessiond.TypeReplacementOutcome,
		sessiond.TypeSetActivePane,
		sessiond.TypeSetActivePaneResult:
		return true
	}
	return false
}

// isRecoverySensitiveTopLevelField includes every recovery field of the
// browser Message contract and every owner-local recovery envelope field. A
// recovery-looking payload under an ordinary type must still take the strict
// decoder lane, so generic decoding cannot discard it.
func isRecoverySensitiveTopLevelField(field string) bool {
	switch field {
	case "recovery",
		"recoveryTransition",
		"recoveryRetry",
		"recoveryRetryResult",
		"recoverySelect",
		"recoverySelectResult",
		"protocolHello",
		"protocolHelloResult",
		"replacementOutcome",
		"recoveredHistory",
		"activePanePersistence",
		"activePanePersistenceResult",
		"privilegedRecovery",
		"lifecycleBootstrap",
		"lifecycleBootstrapResult",
		"lifecycleLeaseDelivery",
		"lifecycleCapture",
		"lifecycleOutcome",
		"explicitBind",
		"explicitBindResult",
		"replacementPlan",
		"replacementResult",
		"replacementCommit",
		"binding",
		"candidateHandle",
		"strategyLabel",
		"detailCode",
		"historyBoundary",
		"canRetry",
		"canSelect",
		"selectionCandidates",
		"sessionId",
		"workingDirectory",
		"cwd",
		"executable",
		"argv",
		"environmentDelta",
		"generation",
		"rootProcessGeneration",
		"captureEpoch",
		"candidateGeneration",
		"strategyId",
		"fence",
		"capability",
		"planId",
		"expiresAt",
		"issuedAt",
		"callback",
		"evidence",
		"launch",
		"rawError",
		"integrationId",
		"namespace",
		"ownership",
		"userConfigPreservation":
		return true
	default:
		return false
	}
}

// classifyBrowserRecoveryInput decodes only bounded top-level RawMessages
// before generic sessiond.Message decoding. Ordinary envelopes retain the
// frozen last-key-wins behavior, but a recovery-sensitive envelope rejects
// every duplicate top-level key so no earlier authority-bearing value can be
// hidden from the strict recovery decoder.
func classifyBrowserRecoveryInput(data []byte) (recoverySensitive bool, cid uint64, err error) {
	if len(data) == 0 || len(data) > maxBrowserTextFrameBytes {
		return false, 0, fmt.Errorf("browser control frame exceeds input limit")
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return false, 0, fmt.Errorf("decode browser control frame: %w", err)
	}
	opening, ok := token.(json.Delim)
	if !ok || opening != '{' {
		return false, 0, errors.New("browser control frame is not an object")
	}

	seenFields := make(map[string]struct{})
	duplicateField := false
	duplicateCID := false
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return recoverySensitive, cid, fmt.Errorf("decode browser control field: %w", err)
		}
		field, ok := token.(string)
		if !ok {
			return recoverySensitive, cid, errors.New("browser control field is not text")
		}
		if _, duplicate := seenFields[field]; duplicate {
			duplicateField = true
			if field == "cid" {
				duplicateCID = true
			}
		} else {
			seenFields[field] = struct{}{}
		}
		if isRecoverySensitiveTopLevelField(field) {
			recoverySensitive = true
		}

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return recoverySensitive, cid, fmt.Errorf("decode browser control value: %w", err)
		}
		switch field {
		case "cid":
			cid = 0
			var candidate uint64
			if err := json.Unmarshal(value, &candidate); err == nil && candidate > 0 {
				cid = candidate
			}
		case "type":
			var messageType string
			if err := json.Unmarshal(value, &messageType); err == nil &&
				isRecoverySensitiveMessageType(messageType) {
				recoverySensitive = true
			}
		}
	}

	token, err = decoder.Token()
	if err != nil {
		return recoverySensitive, cid, fmt.Errorf("decode browser control terminator: %w", err)
	}
	closing, ok := token.(json.Delim)
	if !ok || closing != '}' {
		return recoverySensitive, cid, errors.New("browser control frame has no object terminator")
	}

	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return recoverySensitive, cid, errors.New("browser control frame has trailing JSON value")
		}
		return recoverySensitive, cid, fmt.Errorf("decode trailing browser control value: %w", err)
	}
	if recoverySensitive && duplicateField {
		if duplicateCID {
			// No duplicate CID value is authoritative enough to echo.
			cid = 0
		}
		return true, cid, errors.New("recovery browser control message has a duplicate top-level field")
	}
	return recoverySensitive, cid, nil
}

// sendRecoveryRelayFailure intentionally exposes no daemon, decoder, timeout, or
// system error text to the browser. Recovery failures must not tear down the
// ordinary terminal/config WebSocket lane.
func (c *Client) sendRecoveryRelayFailure(cid uint64) {
	c.sendMessage(&sessiond.Message{
		Type:  sessiond.TypeError,
		CID:   cid,
		Code:  recoveryRelayFailureCode,
		Error: recoveryRelayFailureMessage,
	})
}

// encodeValidatedRecoveryMessage is the final browser-safe validation and
// size boundary for recovery results and events produced by DaemonConn.
func encodeValidatedRecoveryMessage(message *sessiond.Message) ([]byte, bool) {
	if err := sessiond.ValidateBrowserRecoveryMessage(message); err != nil {
		log.Printf("recovery relay: rejected invalid browser-safe output")
		return nil, false
	}
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("recovery relay: could not marshal browser-safe output")
		return nil, false
	}
	if len(data) > sessiond.RecoveryMaxBrowserRecoveryMessageBytes {
		log.Printf("recovery relay: rejected oversized browser-safe output")
		return nil, false
	}
	return data, true
}

func (c *Client) recoveryEventAllowedLocked(messageType string) bool {
	switch messageType {
	case sessiond.TypePaneRecoveryChanged:
		_, ok := c.recoveryCapabilities[sessiond.RecoveryProtocolCapabilityPaneProjection]
		return ok
	case sessiond.TypeRecoveredHistory:
		_, ok := c.recoveryCapabilities[sessiond.RecoveryProtocolCapabilityRecoveredHistory]
		return ok
	case sessiond.TypeReplacementOutcome:
		return true
	default:
		return false
	}
}

func (c *Client) sendRecoveryEvent(event recoveryPendingEvent) bool {
	if c.ctx.Err() != nil {
		return false
	}
	if event.compositionOrdered {
		c.attachSeq.Lock()
		defer c.attachSeq.Unlock()
	}
	if err := c.writeText(event.data); err != nil {
		log.Printf("recovery relay: could not write browser-safe event")
		return false
	}
	return true
}

// relayRecoveryEvent either emits a validated CID-zero event after negotiation
// or retains it in the fixed-capacity hello-completion queue. Events before
// hello, after failure/close, without a negotiated capability, or beyond the
// queue bound are dropped without blocking the daemon read loop.
func (c *Client) relayRecoveryEvent(message *sessiond.Message, compositionOrdered bool) {
	data, ok := encodeValidatedRecoveryMessage(message)
	if !ok {
		return
	}
	event := recoveryPendingEvent{
		messageType:        message.Type,
		data:               data,
		compositionOrdered: compositionOrdered,
	}

	c.recoveryMu.Lock()
	switch c.recoveryHello {
	case recoveryHelloPending, recoveryHelloDraining:
		if c.recoveryEventCount == len(c.recoveryEvents) {
			c.recoveryMu.Unlock()
			log.Printf("recovery relay: pending event queue is full")
			return
		}
		c.recoveryEvents[c.recoveryEventCount] = event
		c.recoveryEventCount++
		c.recoveryMu.Unlock()
		return
	case recoveryHelloReady:
		allowed := c.recoveryEventAllowedLocked(event.messageType)
		c.recoveryMu.Unlock()
		if allowed {
			c.sendRecoveryEvent(event)
		}
	default:
		c.recoveryMu.Unlock()
	}
}

// drainRecoveryEvents serially empties the bounded handshake queue after the
// hello result is on the browser wire. New callbacks remain queued while a
// drain is active, so they cannot overtake earlier events.
func (c *Client) drainRecoveryEvents() {
	for {
		c.recoveryMu.Lock()
		if c.recoveryHello != recoveryHelloDraining {
			c.recoveryMu.Unlock()
			return
		}
		if c.recoveryEventCount == 0 {
			c.recoveryHello = recoveryHelloReady
			c.recoveryMu.Unlock()
			return
		}

		event := c.recoveryEvents[0]
		copy(c.recoveryEvents[:], c.recoveryEvents[1:c.recoveryEventCount])
		c.recoveryEventCount--
		c.recoveryEvents[c.recoveryEventCount] = recoveryPendingEvent{}
		allowed := c.recoveryEventAllowedLocked(event.messageType)
		c.recoveryMu.Unlock()

		if allowed && !c.sendRecoveryEvent(event) {
			c.failProtocolHello()
			return
		}
	}
}

// sendCorrelatedRecoveryResult validates and writes one result while holding
// the matching bounded request slot. It releases that slot before the browser
// can react to the completed write, avoiding a false "in flight" rejection for
// an immediately following recovery request.
func (c *Client) sendCorrelatedRecoveryResult(
	browserCID uint64,
	kind recoveryRequestKind,
	message *sessiond.Message,
) bool {
	data, ok := encodeValidatedRecoveryMessage(message)
	if !ok {
		return false
	}

	c.recoveryMu.Lock()
	defer c.recoveryMu.Unlock()
	if c.recoveryInFlight == nil ||
		c.recoveryInFlight.cid != browserCID ||
		c.recoveryInFlight.kind != kind {
		return false
	}
	if err := c.writeText(data); err != nil {
		log.Printf("recovery relay: could not write correlated output")
		c.recoveryInFlight = nil
		return false
	}
	c.recoveryInFlight = nil
	return true
}

// sendProtocolHelloResult writes the validated hello reply and only then
// atomically enables the negotiated capabilities. Holding recoveryMu across the
// completed write prevents a browser that reacts immediately to the reply from
// racing a retry/select/active-pane request ahead of the ready transition.
func (c *Client) sendProtocolHelloResult(
	browserCID uint64,
	result sessiond.ProtocolHelloResult,
) bool {
	message := &sessiond.Message{
		Type:                sessiond.TypeProtocolHelloResult,
		CID:                 browserCID,
		ProtocolHelloResult: &result,
	}
	data, ok := encodeValidatedRecoveryMessage(message)
	if !ok {
		c.failProtocolHello()
		return false
	}

	c.recoveryMu.Lock()
	if c.recoveryHello != recoveryHelloPending ||
		c.recoveryInFlight == nil ||
		c.recoveryInFlight.cid != browserCID ||
		c.recoveryInFlight.kind != recoveryRequestProtocolHello {
		c.recoveryMu.Unlock()
		return false
	}
	if err := c.writeText(data); err != nil {
		log.Printf("recovery relay: could not write protocol hello output")
		c.recoveryHello = recoveryHelloFailed
		c.recoveryCapabilities = nil
		c.recoveryInFlight = nil
		c.clearPendingRecoveryEventsLocked()
		c.recoveryMu.Unlock()
		return false
	}

	if !result.Compatible {
		c.recoveryHello = recoveryHelloFailed
		c.recoveryCapabilities = nil
		c.recoveryInFlight = nil
		c.clearPendingRecoveryEventsLocked()
		c.recoveryMu.Unlock()
		return true
	}

	c.recoveryHello = recoveryHelloDraining
	c.recoveryCapabilities = make(
		map[sessiond.RecoveryProtocolCapability]struct{},
		len(result.Capabilities.Values),
	)
	for _, capability := range result.Capabilities.Values {
		c.recoveryCapabilities[capability] = struct{}{}
	}
	// The hello result is already on the wire while recoveryMu remains held.
	// The draining state permits negotiated browser requests but queues daemon
	// callbacks until every event that raced hello completion is sent.
	c.recoveryInFlight = nil
	c.recoveryMu.Unlock()
	c.drainRecoveryEvents()
	return true
}

// readPump loops reading messages from the connection.
// On exit it removes the client from the hub.
func (c *Client) readPump() {
	defer c.hub.Remove(c)

	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}

		switch msgType {
		case websocket.MessageBinary:
			c.handleBinaryInput(data)
		case websocket.MessageText:
			c.handleTextInput(data)
		}
	}
}

// handleBinaryInput decodes a binary frame and forwards the payload to the
// daemon as pane input. Binary framing is unchanged from the legacy protocol:
// [4-byte LE uint32 paneId][raw bytes].
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		log.Printf("handleBinaryInput: decode error: %v", err)
		return
	}
	if c.daemon == nil {
		log.Printf("handleBinaryInput: no daemon connection")
		return
	}
	if err := c.daemon.Input(paneID, payload); err != nil {
		log.Printf("handleBinaryInput: Input error: %v", err)
	}
}

// handleTextInput routes recovery-sensitive input through the frozen recovery
// request decoder before the legacy generic Message lane. Ordinary control
// traffic retains its frozen generic behavior.
func (c *Client) handleTextInput(data []byte) {
	recoverySensitive, cid, err := classifyBrowserRecoveryInput(data)
	if err != nil {
		if recoverySensitive {
			c.sendRecoveryRelayFailure(cid)
		} else {
			c.sendError(0, "", fmt.Errorf("invalid JSON: %w", err))
		}
		return
	}
	if recoverySensitive {
		c.handleRecoveryInput(data, cid)
		return
	}

	var msg sessiond.Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendError(0, "", fmt.Errorf("invalid JSON: %w", err))
		return
	}
	if c.daemon == nil {
		c.sendError(msg.CID, msg.WorkspaceID, fmt.Errorf("no daemon connection"))
		return
	}

	switch msg.Type {
	case sessiond.TypeAttach:
		// attachSeq must be held for the entire Attach()+sendMessage sequence:
		// it also gates OnPaneOutput's binary relay (see attachClient), so no
		// replay pane-data frame can reach the WebSocket before the
		// composition reply that announces its pane, preserving the frozen
		// "composition FIRST" wire ordering across the goroutine boundary.
		c.attachSeq.Lock()
		comp, err := c.daemon.Attach(msg.WorkspaceID, msg.Breakpoint, "interactive")
		if err != nil {
			c.attachSeq.Unlock()
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.setWorkspaceID(comp.WorkspaceID)
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeComposition,
			CID:         msg.CID,
			WorkspaceID: comp.WorkspaceID,
			Panes:       comp.Panes,
			Layout:      comp.Layout,
		})
		c.attachSeq.Unlock()

	case sessiond.TypeListWorkspaces:
		workspaces, err := c.daemon.ListWorkspaces()
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:       sessiond.TypeWorkspaceList,
			CID:        msg.CID,
			Workspaces: workspaces,
		})

	case sessiond.TypeCreateWorkspace:
		id, err := c.daemon.CreateWorkspace(msg.Name)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeWorkspaceCreated,
			CID:         msg.CID,
			WorkspaceID: id,
			Name:        msg.Name,
			ClientRef:   msg.ClientRef,
		})

	case sessiond.TypeRenameWorkspace:
		if err := c.daemon.RenameWorkspace(msg.WorkspaceID, msg.Name); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		if wsList, err := c.daemon.ListWorkspaces(); err == nil {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: wsList})
		}

	case sessiond.TypeCloseWorkspace:
		if err := c.daemon.CloseWorkspace(msg.WorkspaceID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		if wsList, err := c.daemon.ListWorkspaces(); err == nil {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: wsList})
		}

	case sessiond.TypeCloseIntent:
		target := sessiond.CloseTarget{
			Kind:        sessiond.CloseTargetKind(msg.TargetKind),
			WorkspaceID: msg.WorkspaceID,
			PaneID:      msg.PaneID,
		}
		outcome, err := c.daemon.CloseIntent(target)
		if err != nil {
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(target)))
			return
		}
		c.rememberCloseTicket(outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCloseConfirm:
		target, knownTarget := c.closeTargetForTicket(msg.Ticket)
		outcome, err := c.daemon.CloseConfirm(msg.Ticket)
		if err != nil {
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(target)))
			return
		}
		c.forgetCloseTicket(msg.Ticket)
		if knownTarget {
			outcome = closeOutcomeWithFallbackTarget(outcome, target)
		}
		c.rememberCloseTicket(outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCreatePane:
		paneID, err := c.daemon.CreatePane(msg.Cmd, msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:   sessiond.TypePaneCreated,
			CID:    msg.CID,
			PaneID: paneID,
		})

	case sessiond.TypeResize:
		// Fire-and-forget: the daemon sends no reply.
		if err := c.daemon.Resize(msg.PaneID, msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: resize error: %v", err)
		}

	case sessiond.TypePaneFocus:
		// Fire-and-forget: the daemon sends no reply.
		if err := c.daemon.PaneFocus(uint32(msg.PaneID), msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: pane-focus error: %v", err)
		}

	case sessiond.TypeRenamePane:
		if err := c.daemon.RenamePane(msg.PaneID, msg.Name); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeClosePane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		// The daemon broadcasts pane-closed to all subscribers; the ok
		// here is just an ack back to the requesting client.
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeSaveLayout:
		if err := c.daemon.SaveLayout(msg.WorkspaceID, msg.Breakpoint, msg.Layout); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeCreateBrowserPane:
		paneID, err := c.daemon.CreateBrowserPane(msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneCreated, CID: msg.CID, PaneID: paneID, ClientRef: msg.ClientRef})

	case sessiond.TypeCloseBrowserPane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeBrowserCommand:
		// Client (or agent, once MCP is wired) relays a command; daemon broadcasts
		// it to the workspace so the pane's owner executes it. Fire-and-forget.
		if err := c.daemon.BrowserCommand(msg.PaneID, msg.CID, msg.Params); err != nil {
			log.Printf("handleTextInput: BrowserCommand error: %v", err)
		}

	case sessiond.TypeBrowserResult:
		// Executing client returns the result; daemon broadcasts it back to the
		// workspace (echoing cid) so the waiting requester receives it.
		if err := c.daemon.BrowserResult(msg.PaneID, msg.CID, msg.Result); err != nil {
			log.Printf("handleTextInput: BrowserResult error: %v", err)
		}

	case sessiond.TypeBrowserURL:
		// Client-to-server notification: URL navigation committed. Daemon
		// broadcasts to workspace subscribers so MCP agents can observe
		// navigation. Fire-and-forget.
		if err := c.daemon.BrowserURL(msg.PaneID, msg.URL); err != nil {
			log.Printf("handleTextInput: BrowserURL error: %v", err)
		}

	case sessiond.TypeBrowserLoad:
		// Client-to-server notification: page load complete. Daemon broadcasts
		// to workspace subscribers. Fire-and-forget.
		if err := c.daemon.BrowserLoad(msg.PaneID, msg.URL); err != nil {
			log.Printf("handleTextInput: BrowserLoad error: %v", err)
		}

	default:
		c.sendError(msg.CID, msg.WorkspaceID, fmt.Errorf("unknown action: %s", msg.Type))
	}
}

// handleRecoveryInput accepts only the four browser-admissible recovery
// request families. DecodeBrowserRecoveryRequest rejects owner-local fields,
// results, events, malformed envelopes, and zero CIDs before any DaemonConn
// method can run.
func (c *Client) handleRecoveryInput(data []byte, classifiedCID uint64) {
	message, err := sessiond.DecodeBrowserRecoveryRequest(data)
	if err != nil {
		c.sendRecoveryRelayFailure(classifiedCID)
		return
	}
	if c.daemon == nil {
		c.sendRecoveryRelayFailure(message.CID)
		return
	}

	switch message.Type {
	case sessiond.TypeProtocolHello:
		c.relayProtocolHello(message)
	case sessiond.TypeRecoveryRetry:
		c.relayRecoveryRetry(message)
	case sessiond.TypeRecoverySelect:
		c.relayRecoverySelect(message)
	case sessiond.TypeSetActivePane:
		c.relaySetActivePane(message)
	default:
		// Kept defensive even though DecodeBrowserRecoveryRequest has already
		// restricted the type set.
		c.sendRecoveryRelayFailure(message.CID)
	}
}

func (c *Client) relayProtocolHello(message *sessiond.Message) {
	if message.ProtocolHello == nil ||
		!c.beginProtocolHello(message.CID) {
		c.sendRecoveryRelayFailure(message.CID)
		return
	}

	browserCID := message.CID
	request := *message.ProtocolHello
	daemon := c.daemon
	go func() {
		result, err := daemon.ProtocolHello(request)
		if !c.recoveryRequestCurrent(browserCID, recoveryRequestProtocolHello) {
			return
		}
		if err != nil ||
			sessiond.ValidateRecoveryContract(result) != nil ||
			!protocolHelloResultMatchesOffer(request, result) {
			c.failProtocolHello()
			c.finishRecoveryRequest(browserCID, recoveryRequestProtocolHello)
			c.sendRecoveryRelayFailure(browserCID)
			return
		}

		if !c.sendProtocolHelloResult(browserCID, result) {
			c.finishRecoveryRequest(browserCID, recoveryRequestProtocolHello)
			c.sendRecoveryRelayFailure(browserCID)
		}
	}()
}

func (c *Client) relayRecoveryRetry(message *sessiond.Message) {
	if message.RecoveryRetry == nil ||
		!c.beginRecoveryRequest(
			message.CID,
			recoveryRequestRetry,
			sessiond.RecoveryProtocolCapabilityRetry,
		) {
		c.sendRecoveryRelayFailure(message.CID)
		return
	}

	browserCID := message.CID
	request := *message.RecoveryRetry
	daemon := c.daemon
	go func() {
		result, err := daemon.RecoveryRetry(request)
		if !c.recoveryRequestCurrent(browserCID, recoveryRequestRetry) {
			return
		}
		if err != nil ||
			sessiond.ValidateRecoveryContract(result) != nil ||
			result.Pane != request.Pane {
			c.finishRecoveryRequest(browserCID, recoveryRequestRetry)
			c.sendRecoveryRelayFailure(browserCID)
			return
		}

		if !c.sendCorrelatedRecoveryResult(browserCID, recoveryRequestRetry, &sessiond.Message{
			Type:                sessiond.TypeRecoveryRetryResult,
			CID:                 browserCID,
			RecoveryRetryResult: &result,
		}) {
			c.finishRecoveryRequest(browserCID, recoveryRequestRetry)
			c.sendRecoveryRelayFailure(browserCID)
		}
	}()
}

func (c *Client) relayRecoverySelect(message *sessiond.Message) {
	if message.RecoverySelect == nil ||
		!c.beginRecoveryRequest(
			message.CID,
			recoveryRequestSelect,
			sessiond.RecoveryProtocolCapabilitySelection,
		) {
		c.sendRecoveryRelayFailure(message.CID)
		return
	}

	browserCID := message.CID
	request := *message.RecoverySelect
	daemon := c.daemon
	go func() {
		result, err := daemon.RecoverySelect(request)
		if !c.recoveryRequestCurrent(browserCID, recoveryRequestSelect) {
			return
		}
		if err != nil || sessiond.ValidateRecoveryContract(result) != nil {
			c.finishRecoveryRequest(browserCID, recoveryRequestSelect)
			c.sendRecoveryRelayFailure(browserCID)
			return
		}

		if !c.sendCorrelatedRecoveryResult(browserCID, recoveryRequestSelect, &sessiond.Message{
			Type:                 sessiond.TypeRecoverySelectResult,
			CID:                  browserCID,
			RecoverySelectResult: &result,
		}) {
			c.finishRecoveryRequest(browserCID, recoveryRequestSelect)
			c.sendRecoveryRelayFailure(browserCID)
		}
	}()
}

func (c *Client) relaySetActivePane(message *sessiond.Message) {
	if message.ActivePanePersistence == nil ||
		!c.beginRecoveryRequest(
			message.CID,
			recoveryRequestSetActivePane,
			sessiond.RecoveryProtocolCapabilityActivePanePersistence,
		) {
		c.sendRecoveryRelayFailure(message.CID)
		return
	}

	browserCID := message.CID
	request := *message.ActivePanePersistence
	daemon := c.daemon
	go func() {
		result, err := daemon.SetActivePane(request)
		if !c.recoveryRequestCurrent(browserCID, recoveryRequestSetActivePane) {
			return
		}
		if err != nil ||
			sessiond.ValidateRecoveryContract(result) != nil ||
			result.Pane != request.Pane {
			c.finishRecoveryRequest(browserCID, recoveryRequestSetActivePane)
			c.sendRecoveryRelayFailure(browserCID)
			return
		}

		if !c.sendCorrelatedRecoveryResult(browserCID, recoveryRequestSetActivePane, &sessiond.Message{
			Type:                        sessiond.TypeSetActivePaneResult,
			CID:                         browserCID,
			ActivePanePersistenceResult: &result,
		}) {
			c.finishRecoveryRequest(browserCID, recoveryRequestSetActivePane)
			c.sendRecoveryRelayFailure(browserCID)
		}
	}()
}

// sendMessage marshals a frozen sessiond.Message and writes it as a text frame.
func (c *Client) sendMessage(msg *sessiond.Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("sendMessage: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendMessage: write error: %v", err)
	}
}

// sendConfig writes the serve-owned resolved configuration as a text frame.
// This is a serve-local envelope ({"type":"config","config":cfg}), NOT a
// sessiond message.
func (c *Client) sendConfig(cfg any) {
	data, err := json.Marshal(map[string]any{"type": "config", "config": cfg})
	if err != nil {
		log.Printf("sendConfig: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendConfig: write error: %v", err)
	}
}

// sendError relays a TypeError envelope to the browser, echoing cid. A
// *sessiond.DaemonError preserves the machine-readable Code (and its
// human-readable text and workspace id) so the browser sees the original error.
func (c *Client) sendError(cid uint64, workspaceID string, err error) {
	m := &sessiond.Message{
		Type:        sessiond.TypeError,
		CID:         cid,
		WorkspaceID: workspaceID,
		Error:       err.Error(),
	}
	var de *sessiond.DaemonError
	if errors.As(err, &de) {
		m.Code = de.Code
		m.Error = de.Err
		if de.WorkspaceID != "" {
			m.WorkspaceID = de.WorkspaceID
		}
	}
	c.sendMessage(m)
}

// close cancels the client context and closes the connection.
func (c *Client) close() {
	c.cancel()
	c.recoveryMu.Lock()
	c.recoveryHello = recoveryHelloFailed
	c.recoveryCapabilities = nil
	c.recoveryInFlight = nil
	c.clearPendingRecoveryEventsLocked()
	c.recoveryMu.Unlock()
	if c.conn != nil {
		c.conn.CloseNow()
	}
}

// Hub manages WebSocket clients, dialing one DaemonConn per browser.
type Hub struct {
	clients        map[*Client]bool
	mu             sync.RWMutex
	dial           DialFunc
	resolvedConfig any             // muxterm-owned resolved config, shipped to clients on connect
	tunnels        *TunnelRegistry // shared tunnel registry for /t/{id}/ proxy
}

// SetResolvedConfig stores the resolved configuration on the hub. The config is
// stored as any so the server package takes no dependency on config package's
// concrete type (only marshals to JSON when sending to clients).
func (h *Hub) SetResolvedConfig(cfg any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resolvedConfig = cfg
}

// BroadcastConfig updates the hub's stored config and sends a {type:"config"}
// frame to every currently-connected client. Used after a PATCH /api/config
// write so all open browser tabs receive the updated configuration immediately.
func (h *Hub) BroadcastConfig(cfg any) {
	h.mu.Lock()
	h.resolvedConfig = cfg
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendConfig(cfg)
	}
}

// sendAIStatus writes the AI capability status as a text frame. Serve-local
// envelope ({"aiStatus":status}), NOT a sessiond message. Deliberately has no
// "type" field -- ws.ts routes flat sessiond messages by their top-level
// "type" string and this frame must never match that path (see sendConfig).
func (c *Client) sendAIStatus(status any) {
	data, err := json.Marshal(map[string]any{"aiStatus": status})
	if err != nil {
		log.Printf("sendAIStatus: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendAIStatus: write error: %v", err)
	}
}

// BroadcastAIStatus sends an {"aiStatus":...} frame to every connected client
// so a key saved in one browser tab flips the capability in all others.
//
// It carries the ai.Status struct only -- which contains no secret by
// construction -- and, unlike BroadcastConfig, caches nothing on the hub: the
// status is cheap to recompute and the browser fetches it on load via
// GET /api/ai/status.
func (h *Hub) BroadcastAIStatus(status any) {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendAIStatus(status)
	}
}

// NewHub creates a new Hub that dials a fresh daemon connection per browser via
// dial. dial may be nil and supplied later via SetDialer. tunnels is nil until
// set by the caller (server.New sets it via hub.tunnels = tunnels).
func NewHub(dial DialFunc) *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
		dial:    dial,
	}
}

// SetDialer installs (or replaces) the per-browser daemon dialer.
func (h *Hub) SetDialer(d DialFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dial = d
}

// Dial creates a new daemon connection using the hub's configured dialer.
// Returns an error if no dialer is set (server not fully initialized).
func (h *Hub) Dial() (DaemonConn, error) {
	h.mu.Lock()
	dial := h.dial
	h.mu.Unlock()
	if dial == nil {
		return nil, fmt.Errorf("server: no sessiond dialer configured")
	}
	return dial()
}

// attachClient dials a daemon for the browser, installs relay handlers that
// forward daemon events to the browser, starts the connection's read loop, and
// seeds the browser with config and the workspace list.
func (h *Hub) attachClient(c *Client) error {
	h.mu.RLock()
	dial := h.dial
	cfg := h.resolvedConfig
	h.mu.RUnlock()

	if dial == nil {
		return fmt.Errorf("attachClient: no dialer configured")
	}

	dc, err := dial()
	if err != nil {
		return fmt.Errorf("attachClient: dial: %w", err)
	}
	c.daemon = dc

	dc.SetHandlers(sessiond.Handlers{
		OnPaneOutput: func(paneID uint32, data []byte) {
			// Blocks while an Attach() reply is being forwarded to the
			// browser/app WebSocket (see attachSeq), so replay frames for the
			// pane just announced in that composition can never overtake it
			// on the wire.
			c.attachSeq.Lock()
			err := c.writeBinary(EncodeBinaryFrame(paneID, data))
			c.attachSeq.Unlock()
			if err != nil {
				log.Printf("attachClient: pane output write error: %v", err)
			}
		},
		OnPaneAdded: func(pane sessiond.PaneInfo) {
			c.sendMessage(&sessiond.Message{
				Type:            sessiond.TypePaneAdded,
				WorkspaceID:     c.getWorkspaceID(),
				PaneID:          pane.PaneID,
				Cols:            pane.Cols,
				Rows:            pane.Rows,
				Title:           pane.Title,
				SurfaceKind:     pane.SurfaceKind,
				Placement:       pane.Placement,
				ReferencePaneID: pane.ReferencePaneID,
			})
		},
		OnPaneClosedWithWorkspace: func(workspaceID string, paneID int, processExitCode *int, runtimeMs int64) {
			c.sendMessage(&sessiond.Message{
				Type: sessiond.TypePaneClosed, WorkspaceID: workspaceID, PaneID: paneID,
				ProcessExitCode: processExitCode, RuntimeMs: runtimeMs,
			})
		},
		OnWorkspaceClosed: func(workspaceID string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceClosed, WorkspaceID: workspaceID})
		},
		OnWorkspaceRenamed: func(workspaceID, name string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceRenamed, WorkspaceID: workspaceID, Name: name})
		},
		OnWorkspaceList: func(workspaces []sessiond.WorkspaceInfo) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: workspaces})
		},
		OnPaneRenamed: func(paneID int, name string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneRenamed, PaneID: paneID, Name: name})
		},
		OnPaneResized: func(paneID uint32, cols, rows int) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneResized, PaneID: int(paneID), Cols: cols, Rows: rows})
		},
		OnPaneRecoveryChanged: func(transition sessiond.PaneRecoveryTransition) {
			c.relayRecoveryEvent(&sessiond.Message{
				Type:               sessiond.TypePaneRecoveryChanged,
				RecoveryTransition: &transition,
			}, true)
		},
		OnRecoveredHistory: func(history sessiond.RecoveredHistoryLiteral) {
			c.relayRecoveryEvent(&sessiond.Message{
				Type:             sessiond.TypeRecoveredHistory,
				RecoveredHistory: &history,
			}, true)
		},
		OnReplacementOutcome: func(outcome sessiond.RecoveryReplacementOutcome) {
			c.relayRecoveryEvent(&sessiond.Message{
				Type:               sessiond.TypeReplacementOutcome,
				ReplacementOutcome: &outcome,
			}, false)
		},
		OnBrowserCommand: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:     sessiond.TypeBrowserCommand,
				PaneID:   msg.PaneID,
				CID:      msg.CID,
				Action:   msg.Action,
				Selector: msg.Selector,
				Params:   msg.Params,
			})
		},
		OnBrowserResult: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserResult,
				PaneID: msg.PaneID,
				CID:    msg.CID,
				Result: msg.Result,
				Error:  msg.Error,
			})
		},
		OnBrowserURL: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserURL,
				PaneID: msg.PaneID,
				URL:    msg.URL,
			})
		},
		OnBrowserLoad: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserLoad,
				PaneID: msg.PaneID,
				URL:    msg.URL,
			})
		},
	})

	go func() {
		if err := dc.Run(); err != nil {
			// net.ErrClosed means hub.Remove closed the daemon connection while
			// dc.Run was blocked in ReadFrame — this is the normal teardown path
			// (readPump exited → hub.Remove → c.daemon.Close → dc.Run unblocks).
			// Don't log noise on every normal browser disconnect.
			//
			// Any other error means the daemon dropped unexpectedly (crash, EOF,
			// etc.) while the browser WebSocket may still be open. Remove the
			// client so the WebSocket is closed and the browser reconnects.
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("attachClient: daemon run exited: %v", err)
			h.Remove(c)
		}
	}()

	if cfg != nil {
		c.sendConfig(cfg)
	}

	workspaces, err := dc.ListWorkspaces()
	if err != nil {
		log.Printf("attachClient: ListWorkspaces error: %v", err)
	} else {
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: workspaces})
	}

	return nil
}

// Add registers a client in the hub and attaches its daemon connection. If
// attachment fails the client is immediately removed so the WebSocket is
// closed and the browser can reconnect rather than hanging in a broken state.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	if err := h.attachClient(c); err != nil {
		log.Printf("Add: attachClient error: %v", err)
		h.Remove(c)
	}
}

// Remove deletes a client from the hub, closes its daemon connection, and
// closes the client.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		if c.daemon != nil {
			_ = c.daemon.Close()
		}
		c.close()
	}
}

// ClientCount returns the number of connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// handleWSImpl handles the WebSocket upgrade and client lifecycle.
func (s *Server) handleWSImpl(w http.ResponseWriter, r *http.Request) {
	originPattern, err := s.validateWebSocketOrigin(r)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{originPattern},
	})
	if err != nil {
		return
	}

	conn.SetReadLimit(maxBrowserTextFrameBytes)

	client := newClient(s.hub, conn)
	s.hub.Add(client)
	go client.readPump()
}

func (s *Server) validateWebSocketOrigin(r *http.Request) (string, error) {
	values := r.Header.Values("Origin")
	if len(values) != 1 || values[0] == "" || strings.TrimSpace(values[0]) != values[0] ||
		strings.Contains(values[0], ",") {
		return "", errors.New("invalid websocket origin")
	}

	rawOrigin := values[0]
	parsed, err := url.Parse(rawOrigin)
	if err != nil || parsed.Opaque != "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.Path != "" || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", errors.New("invalid websocket origin")
	}
	originHost, err := canonicalURLAuthority(parsed)
	if err != nil {
		return "", errors.New("invalid websocket origin")
	}
	origin := parsed.Scheme + "://" + originHost
	if rawOrigin != origin {
		return "", errors.New("invalid websocket origin")
	}

	if s.behindReverseProxy {
		expectedOrigin, expectedHost, err := configuredWebSocketOrigin(s.webRedirectURI)
		if err != nil || origin != expectedOrigin {
			return "", errors.New("invalid websocket origin")
		}
		return webSocketOriginPattern(expectedHost), nil
	}

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	expectedHost, err := validateDirectRequestHost(s.addr, r.Host, scheme)
	if err != nil {
		return "", errors.New("invalid websocket host")
	}
	if origin != scheme+"://"+expectedHost {
		return "", errors.New("invalid websocket origin")
	}
	return webSocketOriginPattern(expectedHost), nil
}

func configuredWebSocketOrigin(callback string) (string, string, error) {
	if callback == "" || strings.TrimSpace(callback) != callback {
		return "", "", errors.New("invalid websocket callback")
	}
	parsed, err := url.Parse(callback)
	if err != nil || parsed.Opaque != "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.Path != "/auth/callback" || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", "", errors.New("invalid websocket callback")
	}
	host, err := canonicalURLAuthority(parsed)
	if err != nil {
		return "", "", errors.New("invalid websocket callback")
	}
	origin := parsed.Scheme + "://" + host
	if callback != origin+"/auth/callback" {
		return "", "", errors.New("invalid websocket callback")
	}
	return origin, host, nil
}

func validateDirectRequestHost(configuredAddr, requestHost, scheme string) (string, error) {
	configuredName, configuredIP, configuredPort, err := parseHostPort(configuredAddr, true)
	if err != nil {
		return "", err
	}
	requestName, requestIP, requestPort, err := parseRequestHostPort(requestHost, configuredPort, scheme)
	if err != nil {
		return "", err
	}
	if configuredPort != 0 && requestPort != configuredPort {
		return "", errors.New("websocket port mismatch")
	}

	configuredWildcard := configuredName == "" ||
		(configuredIP != nil && (configuredIP.IsUnspecified()))
	configuredLoopback := strings.EqualFold(configuredName, "localhost") ||
		(configuredIP != nil && configuredIP.IsLoopback())

	switch {
	case configuredWildcard:
		if requestIP == nil && !strings.EqualFold(requestName, "localhost") {
			return "", errors.New("websocket host mismatch")
		}
	case configuredLoopback:
		if requestIP == nil {
			if !strings.EqualFold(requestName, "localhost") {
				return "", errors.New("websocket host mismatch")
			}
		} else if !requestIP.IsLoopback() {
			return "", errors.New("websocket host mismatch")
		}
	case configuredIP != nil:
		if requestIP == nil || !configuredIP.Equal(requestIP) {
			return "", errors.New("websocket host mismatch")
		}
	default:
		if requestIP != nil || !strings.EqualFold(configuredName, requestName) {
			return "", errors.New("websocket host mismatch")
		}
	}

	host := requestName
	if requestIP != nil {
		host = requestIP.String()
	} else {
		host = strings.ToLower(host)
	}
	return canonicalAuthority(host, strconv.Itoa(requestPort), scheme)
}

func parseHostPort(authority string, configured bool) (string, net.IP, int, error) {
	host, portText, err := net.SplitHostPort(authority)
	if err != nil {
		return "", nil, 0, errors.New("invalid websocket authority")
	}
	return parseAuthorityHostPort(host, portText, configured)
}

// parseRequestHostPort permits a missing Host port only when the configured
// listener port is the default for the request's TLS-derived scheme.
func parseRequestHostPort(authority string, configuredPort int, scheme string) (string, net.IP, int, error) {
	host, portText, err := net.SplitHostPort(authority)
	if err == nil {
		return parseAuthorityHostPort(host, portText, false)
	}
	if configuredPort != defaultPortForScheme(scheme) {
		return "", nil, 0, errors.New("invalid websocket authority")
	}
	return parsePortlessRequestAuthority(authority, configuredPort)
}

func parsePortlessRequestAuthority(authority string, port int) (string, net.IP, int, error) {
	host := authority
	if strings.HasPrefix(host, "[") || strings.HasSuffix(host, "]") {
		if len(host) < 3 || !strings.HasPrefix(host, "[") || !strings.HasSuffix(host, "]") {
			return "", nil, 0, errors.New("invalid websocket authority")
		}
		host = host[1 : len(host)-1]
		if !strings.Contains(host, ":") || net.ParseIP(host) == nil {
			return "", nil, 0, errors.New("invalid websocket authority")
		}
	} else if strings.ContainsAny(host, "[]:") {
		return "", nil, 0, errors.New("invalid websocket authority")
	}
	return parseAuthorityHostPort(host, strconv.Itoa(port), false)
}

func parseAuthorityHostPort(host, portText string, configured bool) (string, net.IP, int, error) {
	if (!configured && host == "") || strings.ContainsAny(host, "%@/\\?#") {
		return "", nil, 0, errors.New("invalid websocket authority")
	}
	port64, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || (!configured && port64 == 0) {
		return "", nil, 0, errors.New("invalid websocket port")
	}

	if host == "" {
		return "", nil, int(port64), nil
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String(), ip, int(port64), nil
	}
	if !validDNSHostname(host) {
		return "", nil, 0, errors.New("invalid websocket hostname")
	}
	return strings.ToLower(host), nil, int(port64), nil
}

func canonicalURLAuthority(parsed *url.URL) (string, error) {
	host := parsed.Hostname()
	if host == "" || strings.ContainsAny(host, "%@/\\?#") || strings.HasSuffix(parsed.Host, ":") {
		return "", errors.New("invalid URL authority")
	}

	canonicalHost := ""
	if ip := net.ParseIP(host); ip != nil {
		canonicalHost = ip.String()
	} else {
		if !validDNSHostname(host) {
			return "", errors.New("invalid URL hostname")
		}
		canonicalHost = strings.ToLower(host)
	}

	return canonicalAuthority(canonicalHost, parsed.Port(), parsed.Scheme)
}

func canonicalAuthority(host, portText, scheme string) (string, error) {
	if portText != "" {
		port64, err := strconv.ParseUint(portText, 10, 16)
		if err != nil || port64 == 0 {
			return "", errors.New("invalid URL port")
		}
		if int(port64) == defaultPortForScheme(scheme) {
			portText = ""
		} else {
			portText = strconv.FormatUint(port64, 10)
		}
	}

	if portText != "" {
		return net.JoinHostPort(host, portText), nil
	}
	if strings.Contains(host, ":") {
		return "[" + host + "]", nil
	}
	return host, nil
}

func defaultPortForScheme(scheme string) int {
	if scheme == "https" {
		return 443
	}
	return 80
}

func webSocketOriginPattern(host string) string {
	// coder/websocket matches OriginPatterns with path.Match. IPv6 literals
	// contain brackets, so escape the opening bracket rather than treating it
	// as a character-class pattern.
	return strings.ReplaceAll(host, "[", "[[]")
}

func validDNSHostname(host string) bool {
	if len(host) == 0 || len(host) > 253 || strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if (char < 'a' || char > 'z') &&
				(char < 'A' || char > 'Z') &&
				(char < '0' || char > '9') && char != '-' {
				return false
			}
		}
	}
	return true
}

// NewServerMsg marshals a single-key JSON object: {msgType: payload}.
func NewServerMsg(msgType string, payload interface{}) ([]byte, error) {
	m := map[string]interface{}{msgType: payload}
	return json.Marshal(m)
}

// EncodeBinaryFrame creates a binary frame: [4-byte LE uint32 pane_id][data].
func EncodeBinaryFrame(paneID uint32, data []byte) []byte {
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame[:4], paneID)
	copy(frame[4:], data)
	return frame
}

// DecodeBinaryFrame extracts pane ID and data from a binary frame.
// Returns an error if the frame is shorter than 4 bytes.
func DecodeBinaryFrame(frame []byte) (uint32, []byte, error) {
	if len(frame) < 4 {
		return 0, nil, fmt.Errorf("binary frame too short: %d bytes, need at least 4", len(frame))
	}
	paneID := binary.LittleEndian.Uint32(frame[:4])
	return paneID, frame[4:], nil
}
