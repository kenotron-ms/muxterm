package voice

// The realtime model's tool surface.
//
// FOUR tools, and the shape of the list is the design:
//
//   - ask_chief_of_staff  -- synchronous, for short work
//   - dispatch_chief_of_staff -- asynchronous fire-and-forget, for long work
//   - answer_approval     -- the voice-approval path, two-step by contract
//   - cancel_chief_of_staff -- stop a turn that is running
//
// Every one of them executes in muxterm's own process, over the sideband,
// and lands on the SAME amplifier session the text chat uses. The realtime
// model never gets a shell; it gets a way to ask the chief of staff for one.
const (
	ToolAsk      = "ask_chief_of_staff"
	ToolDispatch = "dispatch_chief_of_staff"
	ToolApproval = "answer_approval"
	ToolCancel   = "cancel_chief_of_staff"
)

// Instructions is the realtime session's system prompt.
//
// Two things in it are load-bearing rather than stylistic. The first is the
// instruction to speak BEFORE calling a tool: silence during a long turn is
// indistinguishable from a crash, and this is the cheapest defence against
// it. The second is the approval protocol, which is written as a hard rule
// because it is a security surface -- see approvals.go.
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
Never approve on the user's behalf.`
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
	}
}
