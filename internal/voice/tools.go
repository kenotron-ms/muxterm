package voice

// The realtime model's tool surface.
//
// FIVE tools, and the shape of the list is the design:
//
//   - ask_chief_of_staff  -- synchronous, for short work
//   - dispatch_chief_of_staff -- asynchronous fire-and-forget, for long work
//   - answer_approval     -- the voice-approval path, two-step by contract
//   - cancel_chief_of_staff -- stop a turn that is running
//   - end_voice_session    -- hang up, two-step by contract
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

// Instructions is the realtime session's system prompt.
//
// Three things in it are load-bearing rather than stylistic. The first is the
// instruction to speak BEFORE calling a tool: silence during a long turn is
// indistinguishable from a crash, and this is the cheapest defence against
// it. The second is the approval protocol, which is written as a hard rule
// because it is a security surface -- see approvals.go. The third is the
// ending protocol, which is written as a hard rule because "stop" and "end"
// are ordinary words in a conversation about terminals -- see endsession.go.
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
The user cannot hang up by talking to anything except you. When they ask to
leave -- "end the voice session", "hang up", "I'm done talking", "exit voice
mode" -- that is end_voice_session, and it works the same way approvals do.
1. Call end_voice_session with confirm false. You will be given a line to
   read back. Say it and wait.
2. Only after they say yes out loud, call it again with confirm true. Then
   say the goodbye you are asked for, and the connection drops after they
   have heard it.
Hear the difference between the two kinds of stopping. "Stop", "cancel" and
"never mind" while the chief of staff is working mean stop THE WORK: that is
cancel_chief_of_staff, and the conversation continues. Only words about the
conversation, the call, or talking itself end the session. If you cannot tell
which one they meant, ask -- do not guess, and do not reach for the one that
hangs up.
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
			"description": "End the spoken conversation and disconnect. " +
				"Call it TWICE: first with confirm false, which has you read the decision back " +
				"to the user, then -- only after they say yes out loud -- with confirm true, " +
				"which says goodbye and hangs up. A first call with confirm true is refused. " +
				"Only the user ends the conversation: never call this because the conversation " +
				"feels finished or because they have gone quiet.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"confirm": map[string]any{
						"type":        "boolean",
						"description": "False on the first call. True only after the user has confirmed out loud that they want to end the conversation.",
					},
					"farewell": map[string]any{
						"type":        "string",
						"description": "A short line to say before disconnecting. One sentence.",
					},
				},
				"required":             []string{"confirm"},
				"additionalProperties": false,
			},
		},
	}
}
