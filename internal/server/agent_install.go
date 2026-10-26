package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var codingAgentInstallMu sync.Mutex

type installOutput struct {
	mu   sync.Mutex
	tail []byte
}

func (o *installOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.tail = append(o.tail, p...)
	if len(o.tail) > 2048 {
		o.tail = append([]byte(nil), o.tail[len(o.tail)-2048:]...)
	}
	return len(p), nil
}

func runAgentInstaller(ctx context.Context, name string, args []string, stdin []byte) error {
	path, err := exec.LookPath(name)
	if err != nil {
		return fmt.Errorf("%s is not installed; see the setup guide", name)
	}
	cmd := exec.CommandContext(ctx, path, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	output := &installOutput{}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("installation timed out: %w", ctx.Err())
		}
		message := strings.TrimSpace(string(output.tail))
		if message != "" {
			return fmt.Errorf("%s installation failed: %s", name, message)
		}
		return fmt.Errorf("%s installation failed: %w", name, err)
	}
	return nil
}

func installAgentScript(ctx context.Context, url string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return fmt.Errorf("download installer: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download installer: HTTP %d", response.StatusCode)
	}
	script, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil {
		return err
	}
	if len(script) > 2<<20 {
		return errors.New("installer exceeds size limit")
	}
	if len(script) == 0 {
		return errors.New("installer download is empty")
	}
	return runAgentInstaller(ctx, "bash", []string{"-s"}, script)
}

func installCodingAgent(ctx context.Context, harness string) error {
	switch harness {
	case "codex":
		return runAgentInstaller(ctx, "npm", []string{"install", "-g", "@openai/codex@latest"}, nil)
	case "claude":
		return installAgentScript(ctx, "https://claude.ai/install.sh")
	case "opencode":
		return installAgentScript(ctx, "https://opencode.ai/install")
	case "pi":
		return runAgentInstaller(ctx, "npm", []string{"install", "-g", "@earendil-works/pi-coding-agent", "pi-acp"}, nil)
	case "deepseek":
		return runAgentInstaller(ctx, "npm", []string{"install", "-g", "@deepseek-ai/dsh"}, nil)
	case "amplifier":
		return runAgentInstaller(ctx, "uv", []string{"tool", "install", "git+https://github.com/microsoft/amplifier"}, nil)
	default:
		return errors.New("unsupported coding agent")
	}
}

func (s *Server) handleCodingAgentInstall(w http.ResponseWriter, r *http.Request) {
	harness := r.PathValue("harness")
	switch harness {
	case "codex", "claude", "opencode", "pi", "deepseek", "amplifier":
	default:
		http.Error(w, "unsupported coding agent", http.StatusBadRequest)
		return
	}
	if !codingAgentInstallMu.TryLock() {
		http.Error(w, "another coding agent installation is running", http.StatusConflict)
		return
	}
	defer codingAgentInstallMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if err := installCodingAgent(ctx, harness); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"installed": true})
}
