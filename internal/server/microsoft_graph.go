package server

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The community MCP server owns Graph tools, MSAL, and token refresh. Muxterm
// owns the public app registration used by every personal-account connection.
// The client ID is public; device-code sign-in needs no client secret.
const microsoftGraphVersion = "0.158.0"
const microsoftGraphClientID = "aefd0a14-e065-463e-a806-06e1e1465a18"

//go:embed ms365-package/package.json ms365-package/package-lock.json
var microsoftGraphInstallFiles embed.FS

var microsoftGraphArgs = []string{
	"--preset", "mail,calendar,files", "--read-only",
	"--allowed-scopes", "Calendars.Read Files.Read Mail.Read MailboxSettings.Read User.Read",
	"--enabled-tools", "^(?!download-bytes-to-file$).*",
}

type microsoftGraphProfile struct {
	name, tenant    string
	mu              sync.Mutex
	cancel          context.CancelFunc
	generation      uint64
	loginState      string
	code            string
	verificationURL string
	errorMessage    string
	toolCount       int
	checkedAt       time.Time
}

var microsoftGraphProfiles = map[string]*microsoftGraphProfile{
	"personal": {name: "personal", tenant: "consumers"},
}

var microsoftGraphInstallMu sync.Mutex
var microsoftGraphCode = regexp.MustCompile(`(?i)enter the code\s+([A-Z0-9-]{6,14})\b`)
var microsoftGraphURL = regexp.MustCompile(`(?i)https://(?:[a-z0-9-]+\.)*microsoft\.com/[a-z0-9/_?=&%-]+`)

func microsoftGraphRoot() string {
	return filepath.Join(sdkDataDir(), "connections", "microsoft-graph")
}

func microsoftGraphPackageDir() string {
	return filepath.Join(microsoftGraphRoot(), "dependencies", microsoftGraphVersion)
}

func microsoftGraphEntry() string {
	return filepath.Join(microsoftGraphPackageDir(), "node_modules", "@softeria", "ms-365-mcp-server", "dist", "index.js")
}

func microsoftGraphProfileDir(name string) string {
	return filepath.Join(microsoftGraphRoot(), name)
}

func microsoftGraphMarker(name string) string {
	return filepath.Join(microsoftGraphProfileDir(name), "enabled")
}

func microsoftGraphEnabled(name string) bool {
	_, err := os.Stat(microsoftGraphMarker(name))
	return err == nil
}

func microsoftGraphEnvironment(p *microsoftGraphProfile) []string {
	env := make([]string, 0, len(os.Environ())+5)
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		// Inherited vendor settings must never change the client, account
		// authority, cache, or the fixed tool and scope surface.
		if strings.HasPrefix(strings.ToUpper(key), "MS365_MCP_") || key == "XDG_CONFIG_HOME" {
			continue
		}
		env = append(env, item)
	}
	authDir := filepath.Join(microsoftGraphProfileDir(p.name), "auth")
	return append(env,
		"XDG_CONFIG_HOME="+authDir,
		"MS365_MCP_CLIENT_ID="+microsoftGraphClientID,
		"MS365_MCP_TENANT_ID="+p.tenant,
		"MS365_MCP_TOKEN_CACHE_PATH="+filepath.Join(authDir, ".token-cache.json"),
		"MS365_MCP_SELECTED_ACCOUNT_PATH="+filepath.Join(authDir, ".selected-account.json"),
		"MS365_MCP_USE_KEYTAR=0",
	)
}

func microsoftGraphCommand(ctx context.Context, p *microsoftGraphProfile, extra ...string) (*exec.Cmd, error) {
	if _, err := os.Stat(microsoftGraphEntry()); err != nil {
		return nil, errors.New("Microsoft service needs setup in Connections")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, errors.New("Node.js is required for the Microsoft service")
	}
	args := []string{microsoftGraphEntry()}
	args = append(args, microsoftGraphArgs...)
	args = append(args, extra...)
	cmd := exec.CommandContext(ctx, node, args...)
	cmd.Dir = microsoftGraphPackageDir() // Do not load a project-local .env.
	cmd.Env = microsoftGraphEnvironment(p)
	return cmd, nil
}

func ensureMicrosoftGraphPackage(ctx context.Context) error {
	microsoftGraphInstallMu.Lock()
	defer microsoftGraphInstallMu.Unlock()
	if info, err := os.Stat(microsoftGraphEntry()); err == nil && info.Mode().IsRegular() {
		return nil
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return errors.New("Node.js and npm are required to set up the Microsoft service")
	}
	parent := filepath.Dir(microsoftGraphPackageDir())
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(parent, ".install-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	for _, name := range []string{"package.json", "package-lock.json"} {
		data, err := microsoftGraphInstallFiles.ReadFile("ms365-package/" + name)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(tmp, name), data, 0600); err != nil {
			return err
		}
	}
	cmd := exec.CommandContext(ctx, npm, "ci", "--prefix", tmp, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Run(); err != nil {
		log.Printf("microsoft service package download failed: %v", err)
		return errors.New("Microsoft service download failed")
	}
	entry := filepath.Join(tmp, "node_modules", "@softeria", "ms-365-mcp-server", "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		return errors.New("Microsoft service package was incomplete")
	}
	if err := os.RemoveAll(microsoftGraphPackageDir()); err != nil {
		return err
	}
	if err := os.Rename(tmp, microsoftGraphPackageDir()); err != nil {
		return err
	}
	return nil
}

func microsoftGraphDataTool(name string) bool {
	switch name {
	case "login", "logout", "verify-login", "list-accounts", "select-account", "remove-account", "download-bytes-to-file":
		return false
	default:
		return true
	}
}

// RunMicrosoftGraphMCP forwards only data tools from the installed community
// server. Sign-in and sign-out remain owned by Connections, not chat agents.
func RunMicrosoftGraphMCP(ctx context.Context, name string) error {
	p := microsoftGraphProfiles[name]
	if p == nil || !microsoftGraphEnabled(name) {
		return errors.New("Microsoft account is disabled in Connections")
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	cmd, err := microsoftGraphCommand(ctx, p)
	if err != nil {
		return err
	}
	cmd.Stderr = io.Discard
	client := mcp.NewClient(&mcp.Implementation{Name: "muxterm-microsoft-bridge", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		return errors.New("Microsoft's local service could not start")
	}
	defer session.Close()
	tools, err := listRemoteTools(ctx, session)
	if err != nil {
		return errors.New("Microsoft tools could not be listed")
	}
	if !microsoftGraphEnabled(name) {
		return errors.New("Microsoft account is disabled in Connections")
	}
	local := mcp.NewServer(&mcp.Implementation{Name: "muxterm-microsoft-connection", Version: "1"}, nil)
	for _, tool := range tools {
		if tool == nil || !microsoftGraphDataTool(tool.Name) || !validRemoteToolSchema(tool.InputSchema) ||
			(tool.OutputSchema != nil && !validRemoteToolSchema(tool.OutputSchema)) {
			continue
		}
		copy := *tool
		original := tool.Name
		local.AddTool(&copy, func(callCtx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if !microsoftGraphEnabled(name) {
				return nil, errors.New("Microsoft account is disabled in Connections")
			}
			bounded, cancel := context.WithTimeout(callCtx, 2*time.Minute)
			defer cancel()
			return session.CallTool(bounded, &mcp.CallToolParams{Name: original, Arguments: json.RawMessage(request.Params.Arguments)})
		})
	}
	return local.Run(ctx, &mcp.StdioTransport{})
}

func microsoftGraphPublicState(p *microsoftGraphProfile) map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := "disconnected"
	if microsoftGraphEnabled(p.name) {
		state = "ready"
	}
	if p.errorMessage != "" {
		state = "needs-attention"
	}
	if p.cancel != nil || p.loginState == "installing" || p.loginState == "disconnecting" {
		state = "pending"
	}
	return map[string]any{
		"state": state, "loginState": p.loginState, "userCode": p.code,
		"verificationUrl": p.verificationURL, "error": p.errorMessage,
		"toolCount": p.toolCount, "checkedAt": p.checkedAt,
	}
}

func (s *Server) handleMicrosoftGraph(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusOK, map[string]any{
		"personal": microsoftGraphPublicState(microsoftGraphProfiles["personal"]),
	})
}

type microsoftGraphLoginOutput struct {
	p          *microsoftGraphProfile
	generation uint64
	mu         sync.Mutex
	tail       string
}

func (o *microsoftGraphLoginOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	o.tail += string(data)
	if len(o.tail) > 4096 {
		o.tail = o.tail[len(o.tail)-4096:]
	}
	if matches := microsoftGraphCode.FindStringSubmatch(o.tail); len(matches) == 2 {
		url := microsoftGraphURL.FindString(o.tail)
		o.p.mu.Lock()
		if o.p.generation == o.generation && o.p.cancel != nil && url != "" {
			o.p.code = strings.ToUpper(matches[1])
			o.p.verificationURL = url
			o.p.loginState = "pending"
		}
		o.p.mu.Unlock()
	}
	o.mu.Unlock()
	return len(data), nil
}

func (o *microsoftGraphLoginOutput) result() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return microsoftGraphSuccess([]byte(o.tail))
}

func microsoftGraphSuccess(output []byte) bool {
	lines := strings.Split(string(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		var status struct {
			Success *bool `json:"success"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(lines[i])), &status) == nil && status.Success != nil {
			return *status.Success
		}
	}
	return false
}

func (s *Server) handleMicrosoftGraphConnect(w http.ResponseWriter, r *http.Request) {
	p := microsoftGraphProfiles[r.PathValue("account")]
	if p == nil {
		http.Error(w, "unknown Microsoft account type", http.StatusNotFound)
		return
	}
	p.mu.Lock()
	if p.cancel != nil || p.loginState == "installing" || p.loginState == "disconnecting" {
		p.mu.Unlock()
		http.Error(w, "Microsoft sign-in is already running", http.StatusConflict)
		return
	}
	loginCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	p.cancel = cancel
	p.loginState, p.code, p.verificationURL, p.errorMessage = "installing", "", "", ""
	p.generation++
	generation := p.generation
	p.mu.Unlock()
	go runMicrosoftGraphLogin(loginCtx, cancel, p, generation)
	writeSDKJSON(w, http.StatusAccepted, microsoftGraphPublicState(p))
}

func runMicrosoftGraphLogin(loginCtx context.Context, cancel context.CancelFunc, p *microsoftGraphProfile, generation uint64) {
	defer cancel()
	installCtx, stop := context.WithTimeout(loginCtx, 4*time.Minute)
	err := ensureMicrosoftGraphPackage(installCtx)
	stop()
	if err != nil {
		finishMicrosoftGraphLogin(p, generation, 0, err)
		return
	}
	if err := os.MkdirAll(filepath.Join(microsoftGraphProfileDir(p.name), "auth"), 0700); err != nil {
		finishMicrosoftGraphLogin(p, generation, 0, err)
		return
	}
	p.mu.Lock()
	if p.generation != generation || loginCtx.Err() != nil {
		p.mu.Unlock()
		return
	}
	p.loginState = "waiting"
	p.mu.Unlock()
	cmd, err := microsoftGraphCommand(loginCtx, p, "--login")
	if err != nil {
		finishMicrosoftGraphLogin(p, generation, 0, err)
		return
	}
	output := &microsoftGraphLoginOutput{p: p, generation: generation}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		finishMicrosoftGraphLogin(p, generation, 0, err)
		return
	}
	runErr := cmd.Wait()
	success := output.result()
	count := 0
	if runErr == nil && success {
		checkCtx, checkCancel := context.WithTimeout(loginCtx, 30*time.Second)
		count, runErr = checkMicrosoftGraphTools(checkCtx, p)
		checkCancel()
	} else if runErr == nil {
		runErr = errors.New("Microsoft sign-in could not be verified")
	}
	finishMicrosoftGraphLogin(p, generation, count, runErr)
}

func finishMicrosoftGraphLogin(p *microsoftGraphProfile, generation uint64, count int, runErr error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.generation != generation {
		return
	}
	if runErr == nil {
		runErr = os.WriteFile(microsoftGraphMarker(p.name), []byte("enabled\n"), 0600)
	}
	p.cancel, p.code, p.verificationURL = nil, "", ""
	p.loginState = "complete"
	if runErr != nil {
		p.loginState = "error"
		p.errorMessage = "Microsoft sign-in failed; try again"
	} else {
		p.errorMessage, p.toolCount, p.checkedAt = "", count, time.Now()
	}
}

func checkMicrosoftGraphTools(ctx context.Context, p *microsoftGraphProfile) (int, error) {
	cmd, err := microsoftGraphCommand(ctx, p)
	if err != nil {
		return 0, err
	}
	cmd.Stderr = io.Discard
	client := mcp.NewClient(&mcp.Implementation{Name: "muxterm-microsoft-check", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		return 0, err
	}
	defer session.Close()
	tools, err := listRemoteTools(ctx, session)
	if err != nil {
		return 0, errors.New("Microsoft service returned no tools")
	}
	count := 0
	for _, tool := range tools {
		if tool != nil && microsoftGraphDataTool(tool.Name) {
			count++
		}
	}
	if count == 0 {
		return 0, errors.New("Microsoft service returned no data tools")
	}
	// Tool listing proves only that the selected package and preset start. The
	// vendor CLI separately reports whether its own sign-in check succeeded.
	return count, nil
}

func (s *Server) handleMicrosoftGraphCheck(w http.ResponseWriter, r *http.Request) {
	p := microsoftGraphProfiles[r.PathValue("account")]
	if p == nil || !microsoftGraphEnabled(p.name) {
		http.Error(w, "Microsoft account is not connected", http.StatusNotFound)
		return
	}
	p.mu.Lock()
	generation := p.generation
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	cmd, err := microsoftGraphCommand(ctx, p, "--verify-login")
	if err != nil {
		http.Error(w, "Microsoft service is unavailable", http.StatusBadGateway)
		return
	}
	cmd.Stderr = io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "Microsoft service could not be checked", http.StatusBadGateway)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, "Microsoft service could not be checked", http.StatusBadGateway)
		return
	}
	const maxVerificationOutput = 64 << 10
	output, readErr := io.ReadAll(io.LimitReader(stdout, maxVerificationOutput+1))
	if readErr != nil || len(output) > maxVerificationOutput {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if readErr != nil || len(output) > maxVerificationOutput || waitErr != nil || !microsoftGraphSuccess(output) {
		p.mu.Lock()
		if p.generation != generation || !microsoftGraphEnabled(p.name) {
			p.mu.Unlock()
			http.Error(w, "Microsoft connection changed during the check", http.StatusConflict)
			return
		}
		p.errorMessage = "Microsoft authorization needs another sign-in"
		p.toolCount, p.checkedAt = 0, time.Time{}
		p.mu.Unlock()
		http.Error(w, "Microsoft authorization needs another sign-in", http.StatusBadGateway)
		return
	}
	count, err := checkMicrosoftGraphTools(ctx, p)
	if err != nil {
		p.mu.Lock()
		if p.generation != generation || !microsoftGraphEnabled(p.name) {
			p.mu.Unlock()
			http.Error(w, "Microsoft connection changed during the check", http.StatusConflict)
			return
		}
		p.errorMessage = "Microsoft tools could not be reached"
		p.toolCount, p.checkedAt = 0, time.Time{}
		p.mu.Unlock()
		http.Error(w, "Microsoft tools could not be reached", http.StatusBadGateway)
		return
	}
	p.mu.Lock()
	if p.generation != generation || !microsoftGraphEnabled(p.name) {
		p.mu.Unlock()
		http.Error(w, "Microsoft connection changed during the check", http.StatusConflict)
		return
	}
	p.errorMessage, p.toolCount, p.checkedAt = "", count, time.Now()
	p.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, microsoftGraphPublicState(p))
}

func (s *Server) handleMicrosoftGraphDisconnect(w http.ResponseWriter, r *http.Request) {
	p := microsoftGraphProfiles[r.PathValue("account")]
	if p == nil {
		http.Error(w, "unknown Microsoft account type", http.StatusNotFound)
		return
	}
	p.mu.Lock()
	if p.loginState == "disconnecting" {
		p.mu.Unlock()
		http.Error(w, "Microsoft disconnect is already running", http.StatusConflict)
		return
	}
	p.generation++
	if p.cancel != nil {
		p.cancel()
	}
	p.loginState = "disconnecting"
	if err := os.Remove(microsoftGraphMarker(p.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		p.cancel, p.code, p.verificationURL, p.loginState = nil, "", "", "error"
		p.errorMessage = "Microsoft account could not be disabled"
		p.mu.Unlock()
		http.Error(w, "Microsoft account could not be disabled", http.StatusInternalServerError)
		return
	}
	p.mu.Unlock()
	if err := os.RemoveAll(microsoftGraphProfileDir(p.name)); err != nil {
		p.mu.Lock()
		p.cancel, p.code, p.verificationURL, p.loginState = nil, "", "", "error"
		p.errorMessage = "Microsoft account could not be disconnected"
		p.mu.Unlock()
		http.Error(w, fmt.Sprintf("Microsoft %s account could not be disconnected", p.name), http.StatusInternalServerError)
		return
	}
	p.mu.Lock()
	p.cancel, p.code, p.verificationURL, p.loginState, p.errorMessage = nil, "", "", "", ""
	p.toolCount, p.checkedAt = 0, time.Time{}
	p.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, microsoftGraphPublicState(p))
}

func (s *Server) handleMicrosoftGraphCancel(w http.ResponseWriter, r *http.Request) {
	p := microsoftGraphProfiles[r.PathValue("account")]
	if p == nil {
		http.Error(w, "unknown Microsoft account type", http.StatusNotFound)
		return
	}
	p.mu.Lock()
	if p.loginState == "disconnecting" {
		p.mu.Unlock()
		http.Error(w, "Microsoft disconnect is already running", http.StatusConflict)
		return
	}
	p.generation++
	if p.cancel != nil {
		p.cancel()
	}
	p.cancel, p.code, p.verificationURL, p.loginState, p.errorMessage = nil, "", "", "", ""
	p.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, microsoftGraphPublicState(p))
}
