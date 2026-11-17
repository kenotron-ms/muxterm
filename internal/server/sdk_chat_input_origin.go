package server

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

func (h *sdkChatHost) saveInputOrigin(targetID, inputID string, origin sdkEventOrigin) error {
	path := h.controlPath(targetID, "input-origin:"+inputID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(origin)
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0600)
}

func (h *sdkChatHost) inputOrigin(targetID, inputID string) *sdkEventOrigin {
	if inputID == "" {
		return nil
	}
	data, err := os.ReadFile(h.controlPath(targetID, "input-origin:"+inputID))
	if err != nil {
		return nil
	}
	var origin sdkEventOrigin
	if json.Unmarshal(data, &origin) != nil || (origin.Type != "chat-message" && origin.Type != "external-tool") || (origin.Type != "external-tool" && origin.ChatID == "") {
		return nil
	}
	return &origin
}
