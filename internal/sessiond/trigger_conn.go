package sessiond

// Trigger requests over the control socket.
//
// Every one of the four answers with the full current set (TypeTriggerResult),
// so a mutation and a listing are the same reply shape. See the protocol block
// in protocol.go for why.
//
// NOT CONNECTION-SCOPED, and that is the difference from create_pane. A pane is
// created in whatever workspace the connection is attached to; a trigger
// belongs to the daemon and fires when no connection exists at all. There is
// therefore no attach requirement on any of these, and a CLI one-shot can
// manage triggers without attaching to anything.

// createTrigger validates and stores a trigger.
func (c *conn) createTrigger(msg Message) {
	if msg.Trigger == nil {
		c.replyError(msg.CID, CodeTriggerRejected, "no trigger in request")
		return
	}
	t := *msg.Trigger
	// The daemon decides these, never the caller: a client-supplied id could
	// collide with an existing trigger, and client-supplied history or counters
	// would let a caller fabricate a run log.
	t.ID = ""
	t.History = nil
	t.RunCount = 0
	t.ConsecutiveFailures = 0
	t.LastFireAt = 0
	t.LastWorkspaceID = ""
	t.LastPaneID = 0
	t.LastSettled = false
	t.CreatedAt = 0

	if _, err := c.srv.CreateTrigger(t); err != nil {
		c.replyError(msg.CID, CodeTriggerRejected, err.Error())
		return
	}
	c.replyTriggers(msg.CID)
}

func (c *conn) listTriggers(msg Message) {
	c.replyTriggers(msg.CID)
}

func (c *conn) setTriggerEnabled(msg Message) {
	if msg.TriggerEnabled == nil {
		c.replyError(msg.CID, CodeTriggerRejected, "triggerEnabled is required")
		return
	}
	if _, err := c.srv.SetTriggerEnabled(msg.TriggerID, *msg.TriggerEnabled); err != nil {
		c.replyError(msg.CID, CodeTriggerRejected, err.Error())
		return
	}
	c.replyTriggers(msg.CID)
}

func (c *conn) deleteTrigger(msg Message) {
	if err := c.srv.DeleteTrigger(msg.TriggerID); err != nil {
		c.replyError(msg.CID, CodeTriggerRejected, err.Error())
		return
	}
	c.replyTriggers(msg.CID)
}

func (c *conn) replyTriggers(cid uint64) {
	c.reply(&Message{Type: TypeTriggerResult, CID: cid, Triggers: c.srv.ListTriggers()})
}
