package voice

import (
	"sync"
)

type appTurnGate struct {
	mu sync.Mutex

	// generation invalidates an endpoint awaiting a committed input whenever
	// speech resumes. It is intentionally independent of lease/server
	// generation.
	generation uint64
	confirmed  bool
	stopped    bool
	pending    *ProviderEvent
	dispatched bool

	// A raw speech event while output is playing is not enough to call it a
	// human interruption: echo can produce that event. It becomes a turn only
	// when the provider also reports the output it was playing was cleared or
	// cancelled.
	playbackResponse string
	bargeStart       *ProviderEvent
	bargeStopped     bool
}

func newAppTurnGate() *appTurnGate { return &appTurnGate{} }

// observeAppTurnEvent handles only provider input/output ordering. It never
// emits visible state and it never sends response.cancel: WebRTC/provider-owned
// barge-in remains the authority for cancellation.
func (s *Sideband) observeAppTurnEvent(app AppCaptureBridge, event ProviderEvent) {
	if s.appTurns == nil {
		s.appTurns = newAppTurnGate()
	}
	gate := s.appTurns
	switch event.Type {
	case "input_audio_buffer.speech_started":
		gate.speechStarted(app, event)
	case "input_audio_buffer.speech_stopped":
		gate.speechStopped(s, app, event)
	case "input_audio_buffer.committed":
		gate.committed(s, app, event)
	case "output_audio_buffer.started":
		gate.outputStarted(event)
	case "output_audio_buffer.cleared", "response.cancelled":
		gate.outputInterrupted(s, app, event)
	case "output_audio_buffer.stopped":
		gate.outputFinished(event)
	}
}

func (g *appTurnGate) speechStarted(app AppCaptureBridge, event ProviderEvent) {
	g.mu.Lock()
	g.generation++
	g.pending = nil
	g.dispatched = false
	g.stopped = false
	g.bargeStopped = false
	if g.playbackResponse != "" {
		copy := event
		g.bargeStart = &copy
		g.confirmed = false
		g.mu.Unlock()
		return
	}
	g.bargeStart = nil
	g.confirmed = true
	g.mu.Unlock()
	app.BeginAppUserTurn(event)
}

func (g *appTurnGate) speechStopped(s *Sideband, app AppCaptureBridge, _ ProviderEvent) {
	var generation uint64
	var commit bool
	g.mu.Lock()
	if g.bargeStart != nil {
		g.bargeStopped = true
		g.mu.Unlock()
		return
	}
	if g.confirmed && !g.dispatched {
		g.stopped = true
		generation = g.generation
		commit = g.pending != nil
	}
	g.mu.Unlock()
	if commit {
		s.commitAppTurn(app, generation)
	}
}

func (g *appTurnGate) committed(s *Sideband, app AppCaptureBridge, event ProviderEvent) {
	var begin *ProviderEvent
	var generation uint64
	var commit bool

	g.mu.Lock()
	if !g.confirmed {
		if g.bargeStart != nil {
			// A possible echo/barge-in waits for a provider-owned output
			// interruption. It must not call Operator or create a response.
			copy := event
			g.pending = &copy
			g.mu.Unlock()
			return
		}
		// A committed event is the server-VAD provider's confirmation that its
		// configured silence window expired. Keep that fallback for a reordered
		// capture stream that omitted speech edges rather than losing real input.
		g.generation++
		g.confirmed = true
		g.stopped = true
		copy := event
		begin = &copy
	}
	if g.dispatched {
		g.mu.Unlock()
		return
	}
	copy := event
	g.pending = &copy
	generation = g.generation
	commit = g.stopped
	g.mu.Unlock()

	if begin != nil {
		app.BeginAppUserTurn(*begin)
	}
	if commit {
		s.commitAppTurn(app, generation)
	}
}

func (g *appTurnGate) outputStarted(event ProviderEvent) {
	g.mu.Lock()
	g.playbackResponse = event.ResponseID
	g.mu.Unlock()
}

func (g *appTurnGate) outputInterrupted(s *Sideband, app AppCaptureBridge, event ProviderEvent) {
	var begin *ProviderEvent
	var generation uint64
	var commit bool

	g.mu.Lock()
	matchesPlayback := g.playbackResponse != "" &&
		(event.ResponseID == "" || event.ResponseID == g.playbackResponse)
	if matchesPlayback {
		g.playbackResponse = ""
	}
	if !matchesPlayback || g.bargeStart == nil {
		g.mu.Unlock()
		return
	}
	// The provider, not a browser VAD edge, has confirmed deliberate
	// interruption of its actual output. It is now safe to treat the input as
	// a user turn. The provider's configured VAD silence is still the sole
	// endpoint grace; a second local timer would make that delay cumulative.
	copy := *g.bargeStart
	begin = &copy
	g.bargeStart = nil
	g.confirmed = true
	g.stopped = g.bargeStopped
	if g.pending != nil && !g.dispatched {
		generation = g.generation
		commit = g.stopped
	}
	g.mu.Unlock()

	app.BeginAppUserTurn(*begin)
	if commit {
		s.commitAppTurn(app, generation)
	}
}

func (g *appTurnGate) outputFinished(event ProviderEvent) {
	g.mu.Lock()
	if g.playbackResponse != "" &&
		(event.ResponseID == "" || event.ResponseID == g.playbackResponse) {
		g.playbackResponse = ""
	}
	g.mu.Unlock()
}

// playbackActive reports an output whose delivery state this observer has not
// yet seen settle. Reattaching cannot prove whether that output is still
// audible, so treating a subsequent VAD edge as definitely-human would risk
// interpreting playback echo as a new request.
func (g *appTurnGate) playbackActive() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.playbackResponse != ""
}

func (s *Sideband) commitAppTurn(app AppCaptureBridge, generation uint64) {
	gate := s.appTurns
	if gate == nil {
		return
	}
	gate.mu.Lock()
	if !gate.confirmed || gate.generation != generation || gate.pending == nil || gate.dispatched {
		gate.mu.Unlock()
		return
	}
	event := *gate.pending
	gate.pending = nil
	gate.dispatched = true
	gate.mu.Unlock()

	metadata, created, err := app.CommitAppInput(event)
	if err == nil && !created {
		return
	}
	if err != nil || s.RequestScopedResponse(metadata) != nil {
		s.Fence("app provider input commit rejected")
	}
}
