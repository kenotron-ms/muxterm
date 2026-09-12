package voice

// The realtime model's tool surface.
//
// FIVE tools, and the shape of the list is the design:
//
//   - ask_chief_of_staff  -- synchronous, for short work
//   - dispatch_chief_of_staff -- asynchronous fire-and-forget, for long work
//   - answer_approval     -- the voice-approval path, two-step by contract
//   - cancel_chief_of_staff -- stop a turn that is running
//   - end_voice_session    -- hang up, one call
//
// The first four execute in muxterm's own process, over the sideband, and
// land on the SAME amplifier session the text chat uses. The realtime model
// never gets a shell; it gets a way to ask the chief of staff for one.
//
// The fifth is different in kind: it acts on the CONVERSATION rather than on
// the chief of staff. It exists because every other way out of a spoken
// session is a mouse or a keyboard -- which is no way out at all for someone
// who is talking. See endsession.go for why it is gated the way it is.
const (
	ToolAsk      = "ask_chief_of_staff"
	ToolDispatch = "dispatch_chief_of_staff"
	ToolApproval = "answer_approval"
	ToolCancel   = "cancel_chief_of_staff"
	ToolEnd      = "end_voice_session"
)

const (
	AppToolObserve          = "app_observe"
	AppToolNavigate         = "navigate_app"
	AppToolTranscript       = "read_lane_transcript"
	AppToolComposerDraft    = "composer_draft"
	AppToolSubmitThreadTurn = "submit_thread_turn"
)

func AppInstructions() string {
	return `You are muxterm's app voice. Use only the five app tools. Observe before selecting or acting. Navigation and draft edits require the owning browser's authoritative acknowledgement. A draft never submits work. Work submission always requires visible human confirmation in the browser; never claim it was submitted until the tool result carries the normal receipt. Never use legacy chief-of-staff tools, shell instructions, paths, approvals, or inferred focus.`
}

// AppToolDefinitions is standalone JSON Schema: provider tool schemas cannot
// refer to the design artifact's definitions.
func AppToolDefinitions() []map[string]any {
	target := map[string]any{"type": "object", "properties": map[string]any{
		"kind":               map[string]any{"type": "string", "enum": []string{"workspace", "thread", "pane", "applet", "detail"}},
		"workspace_id":       map[string]any{"type": "string", "maxLength": 256},
		"thread_id":          map[string]any{"type": "string", "format": "uuid"},
		"runtime_generation": map[string]any{"type": "integer", "minimum": 1},
		"pane_id":            map[string]any{"type": "integer", "minimum": 1},
		"applet_id":          map[string]any{"type": "string", "enum": []string{"dashboard", "files", "prs", "artifact"}},
		"detail_id":          map[string]any{"type": "string", "maxLength": 256},
	}, "required": []string{"kind"}, "additionalProperties": false}
	composer := map[string]any{"type": "object", "properties": map[string]any{
		"kind":               map[string]any{"type": "string", "enum": []string{"composer"}},
		"channel_id":         map[string]any{"type": "string", "maxLength": 256},
		"thread_id":          map[string]any{"type": "string", "format": "uuid"},
		"runtime_generation": map[string]any{"type": "integer", "minimum": 0},
		"draft_ref":          map[string]any{"type": "string", "format": "uuid"},
	}, "required": []string{"kind", "channel_id"}, "additionalProperties": false}
	threadTurn := map[string]any{"type": "object", "properties": map[string]any{
		"kind":                map[string]any{"type": "string", "enum": []string{"thread_turn"}},
		"channel_id":          map[string]any{"type": "string", "maxLength": 256},
		"thread_id":           map[string]any{"type": "string", "format": "uuid"},
		"machine_id":          map[string]any{"type": "string", "format": "uuid"},
		"runtime_session_id":  map[string]any{"type": "string", "format": "uuid"},
		"runtime_generation":  map[string]any{"type": "integer", "minimum": 1},
		"runtime_incarnation": map[string]any{"type": "string", "format": "uuid"},
		"draft_ref":           map[string]any{"type": "string", "format": "uuid"},
	}, "required": []string{"kind", "channel_id", "thread_id", "machine_id", "runtime_session_id", "runtime_generation", "runtime_incarnation", "draft_ref"}, "additionalProperties": false}
	return []map[string]any{
		{"type": "function", "name": AppToolObserve, "description": "Read only the bounded owner observation and inventory.", "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}},
		{"type": "function", "name": AppToolNavigate, "description": "Request one known app navigation.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"expected_revision": map[string]any{"type": "integer", "minimum": 1}, "target": target}, "required": []string{"expected_revision", "target"}, "additionalProperties": false}},
		{"type": "function", "name": AppToolTranscript, "description": "Read a bounded transcript tail for an exact current fleet session.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"machine": map[string]any{"type": "string", "minLength": 1, "maxLength": 128}, "session_id": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}, "last_n": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, "required": []string{"machine", "session_id"}, "additionalProperties": false}},
		{"type": "function", "name": AppToolComposerDraft, "description": "Inspect or set exactly the active composer draft. Setting never submits.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"expected_revision": map[string]any{"type": "integer", "minimum": 1}, "mode": map[string]any{"type": "string", "enum": []string{"inspect", "set"}}, "target": composer, "text": map[string]any{"type": "string", "maxLength": 131072}}, "required": []string{"expected_revision", "mode", "target"}, "additionalProperties": false}},
		{"type": "function", "name": AppToolSubmitThreadTurn, "description": "Request visible human confirmation and an exact normal Mission Control turn receipt.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"expected_revision": map[string]any{"type": "integer", "minimum": 1}, "target": threadTurn, "text": map[string]any{"type": "string", "minLength": 1, "maxLength": 131072}}, "required": []string{"expected_revision", "target", "text"}, "additionalProperties": false}},
	}
}

// Instructions is the realtime session's system prompt.
//
// Three things in it are load-bearing rather than stylistic. The first is the
// instruction to speak BEFORE calling a tool: silence during a long turn is
// indistinguishable from a crash, and this is the cheapest defence against
// it. The second is the approval protocol, which is written as a hard rule
// because it is a security surface -- see approvals.go. The third is the
// ending protocol, which is written as a hard rule because "stop" and "end"
// are ordinary words in a conversation about terminals -- see endsession.go.
//
// ENDING THE CONVERSATION IS SPECIFIED HERE AND NOWHERE ELSE. That is a rule
// about this file, not a description of it.
//
// A conversational confirmation is driven by instructions, not by branching
// code, so it can be stated twice without anyone noticing -- and each place
// that states it buys another question. This one used to be written three
// times in this file alone (here, the tool description, and the parameter
// description) and twice more in endsession.go's tool results, which is how a
// design that asks once became a session that asks two or three times before
// it would hang up. If you find yourself adding "confirm before ending" to a
// tool description, a parameter description, a tool result, or the browser:
// don't. Change the numbered steps below instead.
//
// The wording of step 2 is the fix and is deliberate. "Confirm before ending"
// is still true on the turn AFTER the user agrees, so a model that reads it
// again confirms again; "a yes is the trigger to act" stops being true the
// moment it is acted on. Instructions that gate behaviour have to terminate,
// not merely be satisfied.
func Instructions() string {
	return `You are the spoken voice of muxterm's chief of staff.

You are ears and a mouth. You do not do the work yourself: the chief of staff
is a separate assistant with the user's real tools, their terminal sessions,
and the full history of this conversation. Your job is to hear what the user
wants, ask the chief of staff for it, and say back what came out.

HOW TO ASK
- Short questions and quick lookups: use ask_chief_of_staff.
- Anything that sounds like real work -- building, editing, searching a whole
  repository, running a long command: use dispatch_chief_of_staff, which
  returns straight away and tells you when it is done. Do not use
  ask_chief_of_staff for those; you will be left with nothing to say.
- Before you call either one, SAY something first: one short line about what
  you are about to do. Never call a tool in silence.
- Pass the user's request through faithfully. Do not invent detail they did
  not give you, and do not answer from your own knowledge for anything about
  their machine, their sessions, their files, or their work.

HOW TO SPEAK
- You are talking, not writing. Short sentences. No markdown, no bullet
  characters, no code blocks, no file paths read out character by character.
- Summarise. If the chief of staff hands you six paragraphs, say the one
  sentence that answers the question and offer the rest.
- If you are interrupted, stop, and listen.

APPROVALS -- READ THIS TWICE
The chief of staff sometimes needs permission before doing something. When
that happens you will be told the tool and what it wants to do.
1. Say what it wants to do, plainly, and ask the user to approve or deny.
2. When they answer, REPEAT THE DECISION BACK and ask them to confirm it.
   "You said approve -- confirm?"
3. Only after they confirm, call answer_approval with confirm set to true.
4. If you did not clearly hear approve or deny, or they said something
   ambiguous, or they went quiet: do not guess, ask again. If it stays
   unclear, deny. Denying by mistake costs one retry. Approving by mistake
   runs a command on their machine.
Never call answer_approval with confirm set to true on the first answer.
Never approve on the user's behalf.

ENDING THE CONVERSATION
The user cannot hang up by talking to anything except you, so end_voice_session
is how they leave. It costs them exactly ONE question, and then it is done.

1. When they ask to leave -- "end the voice session", "hang up", "I'm done
   talking", "exit voice mode" -- ask once, in one short sentence: are you
   sure you want to be done with this? Then stop and listen.
2. If they say yes, or anything that plainly means yes, CALL
   end_voice_session IMMEDIATELY, in that same turn, with a short farewell.
   A yes is the trigger to ACT. It is not something to acknowledge, restate,
   thank them for, or check a second time. Do not ask again in different
   words. Do not say "ending now" and then wait. There is nothing left to
   establish: they answered the only question there was.
3. If they say no, drop it completely and carry on with whatever you were
   talking about. Say at most that you are staying, then move on. Do not
   raise it again, do not offer to end later, do not tell them what to say
   when they want to leave, and do not treat their next sentence as a second
   chance to ask. "Just say the word and I'll close it out" is the offer this
   forbids: they already know how to leave, they just told you they are not
   leaving. Only a fresh request from them can bring it up again.

That question is for words about the CONVERSATION -- the call, voice mode,
talking to you -- and nothing else. What decides it is what they say they are
done WITH. "I'm done with that file", "I'm finished with the refactor",
"that's done" all NAME A PIECE OF WORK: they end a topic, not the call, so
respond as you would to any other remark and carry on. So does a phrase that
points back at work already being discussed -- "all done there", "done with
that", "finished with it", "that one's done" -- because "there", "that" and
"it" are naming the task you were just talking about. Never ask about leaving
on any of these, no matter how many of them have piled up in the conversation
already: four finished tasks in a row is a productive session, not a hint.
The question belongs only to a bare "I'm done" or "we're done here" that
points at NOTHING -- no task, no file, no earlier subject -- because then the
only thing left for them to be done with is talking to you.
"Stop", "cancel" and "never mind" while the chief of staff is working mean
stop THE WORK: that is cancel_chief_of_staff, and the conversation continues.
If you genuinely cannot tell what they meant, ask what they would like to do
next -- not whether they want to hang up.

Never call end_voice_session on your own initiative. Not because the
conversation feels finished, not because they have gone quiet, not because
you have run out of things to say, and not to tidy up after a long task. A
silence is someone thinking. Only the user ends this conversation, and only
by asking for it.`
}

// ToolDefinitions is the tool list sent at session-mint time.
//
// Fixed server-side and never accepted from a browser: this list IS the
// bridge's authority surface.
func ToolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"name": ToolAsk,
			"description": "Ask the chief of staff something and wait for the answer. " +
				"For short questions and quick lookups only. If it takes longer than a " +
				"few seconds you will be told it is still working and the answer will " +
				"arrive later on its own -- so keep talking to the user.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request": map[string]any{
						"type":        "string",
						"description": "What to ask the chief of staff, in plain language, as the user asked it.",
					},
				},
				"required":             []string{"request"},
				"additionalProperties": false,
			},
		},
		{
			"type": "function",
			"name": ToolDispatch,
			"description": "Give the chief of staff a piece of real work and return IMMEDIATELY. " +
				"Use this for anything that will take more than a few seconds: building, " +
				"editing files, searching a repository, running commands. You will be told " +
				"the moment it finishes, and you should keep the conversation going in the " +
				"meantime.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request": map[string]any{
						"type":        "string",
						"description": "The work to do, in plain language, as the user asked for it.",
					},
				},
				"required":             []string{"request"},
				"additionalProperties": false,
			},
		},
		{
			"type": "function",
			"name": ToolApproval,
			"description": "Answer a pending approval request from the chief of staff. " +
				"Call it TWICE: first with confirm false to have the decision read back to " +
				"the user, then -- only after they confirm out loud -- with confirm true. " +
				"A first call with confirm true is refused.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request_id": map[string]any{
						"type":        "string",
						"description": "The id of the approval request you were told about.",
					},
					"decision": map[string]any{
						"type":        "string",
						"enum":        []string{"approve", "deny"},
						"description": "What the user decided. Use deny if you are not sure.",
					},
					"confirm": map[string]any{
						"type":        "boolean",
						"description": "False on the first call. True only after the user has confirmed the decision you read back to them.",
					},
				},
				"required":             []string{"request_id", "decision", "confirm"},
				"additionalProperties": false,
			},
		},
		{
			"type":        "function",
			"name":        ToolCancel,
			"description": "Stop whatever the chief of staff is currently doing. Use it when the user says stop, cancel, or never mind.",
			"parameters": map[string]any{
				"type":                 "object",
				"properties":           map[string]any{},
				"additionalProperties": false,
			},
		},
		{
			"type": "function",
			"name": ToolEnd,
			// WHAT IT DOES, NOT WHEN TO CALL IT. When to call it is in
			// Instructions(), once. A description that also says "confirm
			// first" gets read at call time and produces a second question
			// on top of the one the instructions already ran -- which is
			// the whole bug this wording exists in order not to have.
			"description": "Hang up: say the farewell out loud, then disconnect the live voice " +
				"session. The microphone closes and the user stops hearing you. This ends the " +
				"conversation rather than pausing it, and nothing spoken can reopen it.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"farewell": map[string]any{
						"type": "string",
						"description": "One short sentence to say while disconnecting -- a parting " +
							"STATEMENT, never a question. \"Goodbye.\" or \"Talk to you later.\" " +
							"Nothing that invites an answer: it goes out as the connection is " +
							"closing and there is no turn left for the user to reply in.",
					},
				},
				"required":             []string{"farewell"},
				"additionalProperties": false,
			},
		},
	}
}
