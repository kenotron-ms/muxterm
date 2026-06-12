package mcp

// browserClick clicks the element identified by ref or selector.
// Either ref or selector may be omitted; the shim resolves ref || selector.
func (bt *browserTools) browserClick(args map[string]any) (string, error) {
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "click", map[string]any{"ref": ref, "selector": sel})
}

// browserFill fills the element identified by ref or selector with value.
func (bt *browserTools) browserFill(args map[string]any) (string, error) {
	value, err := argString(args, "value")
	if err != nil {
		return "", err
	}
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "fill", map[string]any{"ref": ref, "selector": sel, "value": value})
}

// browserType types text into the focused element.
// CRITICAL: the tool argument is named "text" but the shim's type_ action reads
// msg.value — so we map the text arg onto the Value field (JSON "value"), not
// the Text field (JSON "text").
func (bt *browserTools) browserType(args map[string]any) (string, error) {
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "type_", map[string]any{"value": text})
}

// browserPress presses a keyboard key (e.g. "Enter", "Tab", "ArrowDown").
func (bt *browserTools) browserPress(args map[string]any) (string, error) {
	key, err := argString(args, "key")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "press", map[string]any{"key": key})
}

// browserHover moves the pointer over the element identified by ref or selector.
func (bt *browserTools) browserHover(args map[string]any) (string, error) {
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "hover", map[string]any{"ref": ref, "selector": sel})
}

// browserSelect selects an option in a <select> element identified by ref or
// selector.
func (bt *browserTools) browserSelect(args map[string]any) (string, error) {
	value, err := argString(args, "value")
	if err != nil {
		return "", err
	}
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "select_", map[string]any{"ref": ref, "selector": sel, "value": value})
}
