package server

func sdkGoalifyInput(id, content string) string {
	return "Muxterm chat ID: " + id + ". If you need to inspect the current goal, use get_chat_goal with session_id=self. Return suggested wording in your reply for the human to review. Only a human can approve and start a proposal or revise the approved condition. Goal controls require the ledger controlVersion and cannot release a human pause.\n\n" + content
}
