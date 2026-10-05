package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The official GitHub server owns the GitHub protocol and tool definitions.
// This list is deliberately narrower than its defaults, and read-only is an
// independent upper bound even if a toolset adds write-capable tools later.
var githubServerArgs = []string{"stdio", "--read-only", "--toolsets=context,repos,issues,pull_requests"}

type connectionCatalogEntry struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Group        string   `json:"group"`
	Description  string   `json:"description"`
	DocsURL      string   `json:"docsUrl"`
	Endpoint     string   `json:"endpoint,omitempty"`
	Availability string   `json:"availability"`
	Scopes       []string `json:"scopes,omitempty"`
	ReadTools    []string `json:"readTools,omitempty"`
}

var connectionCatalog = []connectionCatalogEntry{
	{"github", "GitHub", "Developer", "Repositories, issues, and pull requests", "https://github.com/github/github-mcp-server/releases", "", "local-setup", nil, nil},
	{"onedrive", "OneDrive", "Microsoft 365", "Files through Work IQ", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli", "", "local-cli", nil, nil},
	{"outlook-mail", "Outlook Mail", "Microsoft 365", "Mail through Work IQ", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli", "", "local-cli", nil, nil},
	{"outlook-calendar", "Outlook Calendar", "Microsoft 365", "Meetings through Work IQ", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli", "", "local-cli", nil, nil},
	{"gmail", "Gmail", "Google Workspace", "Messages and drafts", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["gmail"].Endpoint, "developer-preview", googleConnectionPresets["gmail"].Scopes, googleConnectionPresets["gmail"].ReadTools},
	{"google-drive", "Google Drive", "Google Workspace", "Files and search", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["google-drive"].Endpoint, "developer-preview", googleConnectionPresets["google-drive"].Scopes, googleConnectionPresets["google-drive"].ReadTools},
	{"google-calendar", "Google Calendar", "Google Workspace", "Events and availability", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["google-calendar"].Endpoint, "developer-preview", googleConnectionPresets["google-calendar"].Scopes, googleConnectionPresets["google-calendar"].ReadTools},
	{"google-docs", "Google Docs", "Google Workspace", "Documents", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["google-docs"].Endpoint, "developer-preview", googleConnectionPresets["google-docs"].Scopes, googleConnectionPresets["google-docs"].ReadTools},
	{"google-sheets", "Google Sheets", "Google Workspace", "Spreadsheets", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["google-sheets"].Endpoint, "developer-preview", googleConnectionPresets["google-sheets"].Scopes, googleConnectionPresets["google-sheets"].ReadTools},
	{"google-slides", "Google Slides", "Google Workspace", "Presentations", "https://developers.google.com/workspace/guides/configure-mcp-servers", googleConnectionPresets["google-slides"].Endpoint, "developer-preview", googleConnectionPresets["google-slides"].Scopes, googleConnectionPresets["google-slides"].ReadTools},
}

type serviceConnections struct {
	mu          sync.Mutex
	markerPath  string
	generation  uint64
	checkedAt   time.Time
	toolCount   int
	checkErr    string
	installing  bool
	loginState  string
	loginCode   string
	loginError  string
	loginCancel context.CancelFunc
}

func newServiceConnections() *serviceConnections {
	return &serviceConnections{markerPath: GitHubConnectionMarkerPath()}
}

// GitHubConnectionMarkerPath contains only the owner's choice to offer the
// connection to new chats. No credential or token is stored by muxterm.
func GitHubConnectionMarkerPath() string {
	return filepath.Join(sdkDataDir(), "connections", "github-enabled")
}

func githubEnvironment() []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		upper := strings.ToUpper(key)
		// An inherited token must not override the selected gh CLI account.
		// Vendor config env must not relax our fixed read-only/toolset flags.
		if strings.HasPrefix(upper, "GITHUB_") || (strings.HasPrefix(upper, "GH_") && upper != "GH_CONFIG_DIR") {
			continue
		}
		env = append(env, item)
	}
	return env
}

func githubCLIStatus(ctx context.Context) bool {
	gh, err := githubBinary("gh")
	if err != nil {
		return false
	}
	cmd := exec.CommandContext(ctx, gh, "auth", "status", "--active", "--hostname", "github.com")
	cmd.Env = githubEnvironment()
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	return cmd.Run() == nil
}

func githubCLIToken(ctx context.Context) (string, error) {
	gh, err := githubBinary("gh")
	if err != nil {
		return "", errors.New("GitHub tools need setup; open Connections and select Connect GitHub")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, gh, "auth", "token", "--hostname", "github.com")
	cmd.Env = githubEnvironment()
	var out boundedTokenOutput
	cmd.Stdout, cmd.Stderr = &out, io.Discard
	if err := cmd.Run(); err != nil {
		return "", errors.New("Sign in to GitHub in Connections")
	}
	token := strings.TrimSpace(string(out.data))
	if out.overflow || len(token) < 8 || strings.IndexFunc(token, unicode.IsSpace) >= 0 || strings.IndexFunc(token, unicode.IsControl) >= 0 {
		return "", errors.New("GitHub CLI returned an invalid token")
	}
	return token, nil
}

type boundedTokenOutput struct {
	data     []byte
	overflow bool
}

func (o *boundedTokenOutput) Write(p []byte) (int, error) {
	n := len(p)
	const maxTokenOutput = 4096
	remaining := maxTokenOutput - len(o.data)
	if remaining < n {
		o.overflow = true
		p = p[:remaining]
	}
	o.data = append(o.data, p...)
	return n, nil
}

func githubMCPCommand(ctx context.Context) (*exec.Cmd, error) {
	server, err := githubBinary("github-mcp-server")
	if err != nil {
		return nil, errors.New("GitHub tools need setup; open Connections and select Connect GitHub")
	}
	token, err := githubCLIToken(ctx)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, server, githubServerArgs...)
	cmd.Env = append(githubEnvironment(), "GITHUB_PERSONAL_ACCESS_TOKEN="+token)
	// Neither gh's output nor the vendor server's stderr can enter muxterm
	// logs, browser responses, an agent transcript, or a process argument.
	cmd.Stderr = io.Discard
	return cmd, nil
}

// RunGitHubConnectionMCP is the fixed harness command. The vendor server owns
// the actual MCP session; muxterm forwards stdio without translating tools.
func RunGitHubConnectionMCP(ctx context.Context) error {
	if _, err := os.Stat(GitHubConnectionMarkerPath()); err != nil {
		return errors.New("GitHub is disabled in Connections")
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	cmd, err := githubMCPCommand(ctx)
	if err != nil {
		return err
	}
	cmd.Stdin, cmd.Stdout = os.Stdin, os.Stdout
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return errors.New("GitHub's local service exited unexpectedly")
	}
	return nil
}

func (s *Server) handleConnections(w http.ResponseWriter, r *http.Request) {
	c := s.connections
	c.mu.Lock()
	_, markerErr := os.Stat(c.markerPath)
	enabled := markerErr == nil
	checkedAt, toolCount, checkErr := c.checkedAt, c.toolCount, c.checkErr
	installing, loginState, loginCode, loginError := c.installing, c.loginState, c.loginCode, c.loginError
	c.mu.Unlock()
	ghInstalled := false
	if _, err := githubBinary("gh"); err == nil {
		ghInstalled = true
	}
	serverInstalled := false
	if _, err := githubBinary("github-mcp-server"); err == nil {
		serverInstalled = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	signedIn := ghInstalled && githubCLIStatus(ctx)
	state := "setup-required"
	if ghInstalled && serverInstalled && signedIn {
		state = "available"
		if enabled {
			state = "verify-required"
			if checkErr != "" {
				state = "needs-attention"
			} else if !checkedAt.IsZero() && time.Since(checkedAt) < 5*time.Minute {
				state = "ready"
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, 200, map[string]any{"catalog": connectionCatalog, "github": map[string]any{
		"state": state, "enabled": enabled, "ghInstalled": ghInstalled, "serverInstalled": serverInstalled,
		"signedIn": signedIn, "toolCount": toolCount, "checkedAt": checkedAt, "error": checkErr,
		"installing": installing, "loginState": loginState, "loginCode": loginCode, "loginError": loginError,
	}})
}

func (s *Server) handleGitHubCheck(w http.ResponseWriter, r *http.Request) {
	c := s.connections
	c.mu.Lock()
	generation := c.generation
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	cmd, err := githubMCPCommand(ctx)
	count := 0
	if err == nil {
		client := mcp.NewClient(&mcp.Implementation{Name: "muxterm-connections", Version: "1"}, nil)
		session, connectErr := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
		err = connectErr
		if err == nil {
			defer session.Close()
			cursor := ""
			hasIdentityTool := false
			for {
				var params *mcp.ListToolsParams
				if cursor != "" {
					params = &mcp.ListToolsParams{Cursor: cursor}
				}
				result, listErr := session.ListTools(ctx, params)
				if listErr != nil {
					err = listErr
					break
				}
				count += len(result.Tools)
				for _, tool := range result.Tools {
					if tool.Name == "get_me" {
						hasIdentityTool = true
					}
				}
				if result.NextCursor == "" {
					break
				}
				cursor = result.NextCursor
			}
			if err == nil && count == 0 {
				err = errors.New("GitHub returned no tools")
			}
			if err == nil && !hasIdentityTool {
				err = errors.New("GitHub identity tool was not available")
			}
			if err == nil {
				identity, callErr := session.CallTool(ctx, &mcp.CallToolParams{Name: "get_me", Arguments: map[string]any{}})
				if callErr != nil || identity == nil || identity.IsError {
					err = errors.New("GitHub did not verify the current account")
				}
			}
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation != generation {
		http.Error(w, "GitHub connection changed during the check", http.StatusConflict)
		return
	}
	c.checkedAt, c.toolCount = time.Now(), count
	if err != nil {
		c.checkErr = "GitHub tools could not be reached; check the local server and CLI login"
		http.Error(w, c.checkErr, http.StatusBadGateway)
		return
	}
	if err := os.MkdirAll(filepath.Dir(c.markerPath), 0700); err != nil {
		c.checkErr = "GitHub tools were found, but Connections could not save the enable choice"
		http.Error(w, c.checkErr, http.StatusInternalServerError)
		return
	}
	marker, markerErr := os.CreateTemp(filepath.Dir(c.markerPath), "github-enabled-*")
	if markerErr == nil {
		defer os.Remove(marker.Name())
		markerErr = marker.Chmod(0600)
		closeErr := marker.Close()
		if markerErr == nil {
			markerErr = closeErr
		}
		if markerErr == nil {
			markerErr = os.Rename(marker.Name(), c.markerPath)
		}
	}
	if markerErr != nil {
		c.checkErr = "GitHub tools were found, but Connections could not save the enable choice"
		http.Error(w, c.checkErr, http.StatusInternalServerError)
		return
	}
	c.checkErr = ""
	writeSDKJSON(w, 200, map[string]any{"state": "ready", "toolCount": count})
}

func (s *Server) handleGitHubDisconnect(w http.ResponseWriter, _ *http.Request) {
	c := s.connections
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.Remove(c.markerPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Could not disable GitHub for new chats", http.StatusInternalServerError)
		return
	}
	c.generation++
	c.checkedAt, c.toolCount, c.checkErr = time.Time{}, 0, ""
	writeSDKJSON(w, 200, map[string]string{"state": "available"})
}
