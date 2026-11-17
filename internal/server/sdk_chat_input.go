package server

func sdkChatInput(id, content string) string {
	return "Muxterm chat ID: " + id + ". If goal coordination is needed for your assignment, read get_chat_goal using session_id=self and propose a condition through report_goal_evidence; proposals are inert. Do not add goal-management work to an unrelated assignment. Only a human can approve and start a proposal or revise the approved condition. Goal controls require the ledger controlVersion and cannot release a human pause.\n\n" + content
}
