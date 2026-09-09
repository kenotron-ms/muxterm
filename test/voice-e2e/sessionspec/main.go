// Command sessionspec prints the EXACT realtime session configuration
// muxterm mints -- its instructions and its tool list -- as JSON on stdout.
//
// # WHY IT EXISTS
//
// The spoken exit is enforced by INSTRUCTIONS, not by branching code. A
// conversational proof is therefore only worth something if the conversation
// ran against the instructions that actually ship: a harness holding its own
// pasted copy of the prompt proves that the copy behaves, which is not a fact
// about muxterm and stops being true the first time the real one is edited.
//
// So the harness does not hold a copy. It runs this, and talks to the model
// with whatever internal/voice returns today.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/kenotron-ms/muxterm/internal/voice"
)

func main() {
	out, err := json.Marshal(map[string]any{
		"instructions": voice.Instructions(),
		"tools":        voice.ToolDefinitions(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "sessionspec:", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(out); err != nil {
		os.Exit(1)
	}
}
