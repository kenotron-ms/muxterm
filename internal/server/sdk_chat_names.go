package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// The opening human input gets one naming attempt. Generated and native titles
// are stable thereafter, including for chats created before this policy.
func (h *sdkChatHost) scheduleNamingLocked(c *sdkChat) {
	// Generic ACP chats keep their opening title until a person renames them.
	// The title generator below invokes Codex and must not become a hidden
	// dependency of Pi, OpenCode, or DeepSeek chat creation.
	if isSDKACPHarness(c.Harness) {
		return
	}
	if c.TitleSource != "opening" || c.State != "ready" || c.UserTurns != 1 || c.TitleCheckedTurn != 0 || h.naming[c.ID] {
		return
	}
	c.TitleCheckedTurn = c.UserTurns
	_ = h.saveLocked(c)
	h.naming[c.ID] = true
	go h.nameAfterTurns(c.ID)
}

func (h *sdkChatHost) nameAfterTurns(id string) {
	defer func() {
		h.mu.Lock()
		delete(h.naming, id)
		h.mu.Unlock()
	}()
	nameLock := h.nameLock(id)
	nameLock.Lock()
	defer nameLock.Unlock()
	h.mu.Lock()
	c := h.chats[id]
	if c == nil || c.TitleSource == "manual" {
		h.mu.Unlock()
		return
	}
	chat := *c
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := h.resume(ctx, &chat); err != nil {
		return
	}
	raw, err := h.call(ctx, "title", map[string]any{"sessionId": id, "mode": "read"})
	if err != nil {
		return
	}
	var native struct{ Name, Source, FirstPrompt string }
	if json.Unmarshal(raw, &native) != nil {
		return
	}
	name := ""
	source := ""
	// Native stores call a previously generated title a custom name. It is
	// still replaceable only while it matches the title we last wrote.
	if native.Source == "manual" && strings.TrimSpace(native.Name) != "" &&
		(chat.TitleSource != "generated" || native.Name != chat.Title) {
		name, source = native.Name, "manual"
	} else if candidate := shortPurposeTitle(native.Name); candidate != "" &&
		(chat.TitleSource == "" || chat.TitleSource == "opening") &&
		(native.Source == "native" || native.Source == "generated") &&
		!strings.EqualFold(strings.TrimSpace(native.Name), strings.TrimSpace(native.FirstPrompt)) {
		name, source = candidate, "native"
	}
	if name == "" {
		inputs, readErr := h.namingInputs(id)
		if readErr != nil || len(inputs) == 0 {
			return
		}
		name, err = generatePurposeTitle(ctx, chat.ProjectPath, inputs)
		if err != nil || name == "" {
			return
		}
		source = "generated"
	}
	if name == "" {
		return
	}
	h.mu.Lock()
	c = h.chats[id]
	stillEligible := c != nil && c.TitleSource == "opening" && c.Title == chat.Title
	h.mu.Unlock()
	if !stillEligible {
		return
	}
	if name == chat.Title && source != "manual" {
		return
	}
	if source == "generated" {
		generated := name
		previousName := ""
		if chat.TitleSource == "generated" {
			previousName = chat.Title
		}
		raw, err = h.call(ctx, "title", map[string]any{"sessionId": id, "mode": "generated", "name": name, "previousName": previousName})
		if err != nil {
			return
		}
		var applied struct{ Name, Source string }
		if json.Unmarshal(raw, &applied) != nil || applied.Name == "" {
			return
		}
		name = applied.Name
		if applied.Source == "manual" {
			source = "manual"
		}
		if applied.Source != "manual" && applied.Name != generated {
			return
		}
	}
	h.mu.Lock()
	c = h.chats[id]
	if c == nil || c.TitleSource != "opening" || c.Title != chat.Title {
		h.mu.Unlock()
		return
	}
	c.Title, c.TitleSource = name, source
	err = h.saveLocked(c)
	h.mu.Unlock()
	if err == nil {
		h.appendEvent(sdkEvent{SessionID: id, Type: "session.renamed", Name: name})
	}
}

func (h *sdkChatHost) namingInputs(id string) ([]string, error) {
	f, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), 2<<20)
	var inputs []string
	for scanner.Scan() {
		var ev sdkEvent
		if json.Unmarshal(scanner.Bytes(), &ev) == nil && ev.Type == "input.accepted" && ev.Kind == "user" && ev.Origin == nil && ev.Source != "operator-lane" && ev.Source != "chat-message" {
			if input := strings.TrimSpace(ev.Text); input != "" {
				inputs = append(inputs, string([]rune(input)[:min(len([]rune(input)), 1200)]))
			}
		}
	}
	if len(inputs) > 1 {
		inputs = inputs[:1]
	}
	return inputs, scanner.Err()
}

func shortPurposeTitle(s string) string {
	s = strings.TrimSpace(strings.Trim(s, "\"'`#*"))
	s = strings.Join(strings.Fields(s), " ")
	if len(s) == 0 || strings.ContainsAny(s, "\n\r") {
		return ""
	}
	if strings.IndexFunc(s, unicode.IsLower) == -1 {
		s = strings.ToLower(s)
	}
	r := []rune(s)
	if len(r) == 0 {
		return ""
	}
	r[0] = unicode.ToUpper(r[0])
	s = string(r)
	if len([]rune(s)) > 28 {
		parts := strings.Fields(s)
		s = ""
		for _, part := range parts {
			if len([]rune(strings.TrimSpace(s+" "+part))) > 28 {
				break
			}
			if s != "" {
				s += " "
			}
			s += part
		}
	}
	if len(strings.Fields(s)) < 2 {
		return ""
	}
	for _, generic := range []string{"Hello there", "Just chatting", "New chat", "Quick question", "How can i", "Ready to help"} {
		if strings.EqualFold(s, generic) {
			return ""
		}
	}
	return strings.TrimRight(s, ".:;,- ")
}

func generatePurposeTitle(ctx context.Context, cwd string, inputs []string) (string, error) {
	var prompt strings.Builder
	prompt.WriteString("Give this conversation a specific, sentence-case sidebar title of 3–5 words, at most 28 characters. Use a concrete action and object from the opening request. Do not quote the request or describe the assistant. Output the title only. Do not use tools.\n\nOpening human message:\n")
	for _, input := range inputs {
		prompt.WriteString("- ")
		prompt.WriteString(input)
		prompt.WriteByte('\n')
	}
	cmd := exec.CommandContext(ctx, "codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-m", "gpt-6-luna", "-s", "read-only", "-C", cwd, "-")
	cmd.Stdin = strings.NewReader(prompt.String())
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", errors.New("title generation failed: " + err.Error() + ": " + sdkTail(stderr.String(), 300))
	}
	var title string
	scanner := bufio.NewScanner(&stdout)
	scanner.Buffer(make([]byte, 64<<10), 2<<20)
	for scanner.Scan() {
		var item struct {
			Type string
			Item struct{ Type, Text string }
		}
		if json.Unmarshal(scanner.Bytes(), &item) == nil && item.Type == "item.completed" && item.Item.Type == "agent_message" {
			title = item.Item.Text
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return shortPurposeTitle(title), nil
}
