package server

import (
	"encoding/json"
	"testing"
)

func TestConfigMessageEnvelope(t *testing.T) {
	resolved := map[string]any{
		"theme":    map[string]any{"palette": "tokyo-night"},
		"terminal": map[string]any{"scrollback": 10000},
	}
	data, err := NewServerMsg("config", resolved)
	if err != nil {
		t.Fatalf("NewServerMsg: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := got["config"]; !ok {
		t.Fatalf("envelope missing top-level \"config\" key: %s", data)
	}
}
