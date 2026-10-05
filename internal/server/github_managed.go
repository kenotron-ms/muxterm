package server

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// These are immutable official release archives and their published SHA-256
// checksums. Updating either version requires updating all platform hashes.
const githubMCPVersion = "1.14.0"
const githubCLIVersion = "2.102.0"

type githubReleaseAsset struct {
	url, sha256, binary string
}

func githubReleaseAssets() ([]githubReleaseAsset, error) {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	var serverName, serverHash, cliName, cliHash string
	switch platform {
	case "linux/amd64":
		serverName, serverHash = "github-mcp-server_Linux_x86_64.tar.gz", "2fcad56bb164b6c4918fdd9f1d5572257bf4e1f14b7eb1119d015b079818fd38"
		cliName, cliHash = "gh_2.102.0_linux_amd64.tar.gz", "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386"
	case "linux/arm64":
		serverName, serverHash = "github-mcp-server_Linux_arm64.tar.gz", "dd06beb81e62c42afa2d4217d86be79ca588a083f63da38ca3cbef0b7785e88d"
		cliName, cliHash = "gh_2.102.0_linux_arm64.tar.gz", "7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484"
	case "darwin/amd64":
		serverName, serverHash = "github-mcp-server_Darwin_x86_64.tar.gz", "82c84d005eaef04755295e1bf0118766f59ef39196bf8142e58b5aca9e16c6ac"
		cliName, cliHash = "gh_2.102.0_macOS_amd64.zip", "b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3"
	case "darwin/arm64":
		serverName, serverHash = "github-mcp-server_Darwin_arm64.tar.gz", "e3baa88424ecc24ae504a1c98c128823fc2c2edbe9dd64e1456f39edea701140"
		cliName, cliHash = "gh_2.102.0_macOS_arm64.zip", "da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e"
	default:
		return nil, fmt.Errorf("automatic GitHub setup is unavailable on %s", platform)
	}
	return []githubReleaseAsset{
		{fmt.Sprintf("https://github.com/github/github-mcp-server/releases/download/v%s/%s", githubMCPVersion, serverName), serverHash, "github-mcp-server"},
		{fmt.Sprintf("https://github.com/cli/cli/releases/download/v%s/%s", githubCLIVersion, cliName), cliHash, "gh"},
	}, nil
}

func githubManagedBinary(name string) string {
	version := githubMCPVersion
	if name == "gh" {
		version = githubCLIVersion
	}
	return filepath.Join(sdkDataDir(), "connections", "bin", name+"-"+version)
}

func githubBinary(name string) (string, error) {
	managed := githubManagedBinary(name)
	if info, err := os.Stat(managed); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
		return managed, nil
	}
	return "", fmt.Errorf("%s is not installed in Connections", name)
}

func ensureGitHubManaged(ctx context.Context) error {
	assets, err := githubReleaseAssets()
	if err != nil {
		return err
	}
	for _, asset := range assets {
		if _, lookupErr := githubBinary(asset.binary); lookupErr == nil {
			continue
		}
		if err := downloadGitHubAsset(ctx, asset); err != nil {
			return err
		}
	}
	return nil
}

func downloadGitHubAsset(ctx context.Context, asset githubReleaseAsset) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("official download returned HTTP %d", resp.StatusCode)
	}
	const maxArchive = 128 << 20
	archive, err := io.ReadAll(io.LimitReader(resp.Body, maxArchive+1))
	if err != nil {
		return err
	}
	if len(archive) > maxArchive {
		return errors.New("official download exceeded size limit")
	}
	hash := sha256.Sum256(archive)
	if hex.EncodeToString(hash[:]) != asset.sha256 {
		return errors.New("official download checksum did not match")
	}
	var contents []byte
	matches := 0
	if strings.HasSuffix(asset.url, ".zip") {
		reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return err
		}
		for _, entry := range reader.File {
			if filepath.Base(entry.Name) != asset.binary || !entry.Mode().IsRegular() {
				continue
			}
			matches++
			if matches > 1 {
				return errors.New("official archive contains duplicate binaries")
			}
			file, err := entry.Open()
			if err != nil {
				return err
			}
			contents, err = io.ReadAll(io.LimitReader(file, 80<<20))
			file.Close()
			if err != nil {
				return err
			}
		}
	} else {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return err
		}
		defer gz.Close()
		reader := tar.NewReader(gz)
		for {
			entry, err := reader.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			if filepath.Base(entry.Name) != asset.binary || entry.Typeflag != tar.TypeReg {
				continue
			}
			matches++
			if matches > 1 {
				return errors.New("official archive contains duplicate binaries")
			}
			contents, err = io.ReadAll(io.LimitReader(reader, 80<<20))
			if err != nil {
				return err
			}
		}
	}
	if len(contents) == 0 || len(contents) >= 80<<20 {
		return errors.New("official archive did not contain a valid binary")
	}
	destination := githubManagedBinary(asset.binary)
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".github-install-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(contents); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Chmod(0700); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), destination)
}

func (s *Server) handleGitHubInstall(w http.ResponseWriter, r *http.Request) {
	c := s.connections
	c.mu.Lock()
	if c.installing {
		c.mu.Unlock()
		http.Error(w, "GitHub setup is already running", http.StatusConflict)
		return
	}
	c.installing = true
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.installing = false; c.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
	defer cancel()
	err := ensureGitHubManaged(ctx)
	if err != nil {
		http.Error(w, "GitHub setup failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]string{"state": "installed"})
}

var githubDeviceCode = regexp.MustCompile(`\b[A-Z0-9]{4}-[A-Z0-9]{4}\b`)

type githubLoginOutput struct {
	connections *serviceConnections
	tail        string
}

func (o *githubLoginOutput) Write(p []byte) (int, error) {
	o.tail += string(p)
	if len(o.tail) > 512 {
		o.tail = o.tail[len(o.tail)-512:]
	}
	if code := githubDeviceCode.FindString(o.tail); code != "" {
		o.connections.mu.Lock()
		if o.connections.loginState == "waiting" {
			o.connections.loginCode, o.connections.loginState = code, "pending"
		}
		o.connections.mu.Unlock()
	}
	return len(p), nil
}

func (s *Server) handleGitHubLogin(w http.ResponseWriter, r *http.Request) {
	c := s.connections
	c.mu.Lock()
	if c.loginState == "waiting" || c.loginState == "pending" {
		c.mu.Unlock()
		http.Error(w, "GitHub sign-in is already in progress", http.StatusConflict)
		return
	}
	c.loginState, c.loginCode, c.loginError = "waiting", "", ""
	c.mu.Unlock()
	gh, err := githubBinary("gh")
	if err != nil {
		c.mu.Lock()
		c.loginState = "error"
		c.loginError = "Install GitHub tools first"
		c.mu.Unlock()
		http.Error(w, "Install GitHub tools first", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	c.mu.Lock()
	if c.loginState != "waiting" {
		c.mu.Unlock()
		cancel()
		http.Error(w, "GitHub sign-in was cancelled", http.StatusConflict)
		return
	}
	c.loginCancel = cancel
	c.mu.Unlock()
	cmd := exec.CommandContext(ctx, gh, "auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key")
	cmd.Env = append(githubEnvironment(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "CLICOLOR=0")
	cmd.Stdin, cmd.Stdout = nil, io.Discard
	cmd.Stderr = &githubLoginOutput{connections: c}
	if err := cmd.Start(); err != nil {
		cancel()
		c.mu.Lock()
		c.loginState, c.loginError = "error", "Could not start GitHub sign-in"
		c.loginCancel = nil
		c.mu.Unlock()
		http.Error(w, "Could not start GitHub sign-in", http.StatusBadGateway)
		return
	}
	go func() {
		err := cmd.Wait()
		cancel()
		c.mu.Lock()
		defer c.mu.Unlock()
		c.loginCancel = nil
		c.loginCode = ""
		if c.loginState == "cancelled" {
			return
		}
		if err != nil {
			c.loginState, c.loginError = "error", "GitHub sign-in did not complete"
		} else {
			c.loginState, c.loginError = "complete", ""
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusAccepted, map[string]string{"state": "waiting"})
}

func (s *Server) handleGitHubLoginCancel(w http.ResponseWriter, _ *http.Request) {
	c := s.connections
	c.mu.Lock()
	if c.loginCancel != nil {
		c.loginCancel()
	}
	c.loginState, c.loginCode, c.loginError = "cancelled", "", ""
	c.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, map[string]string{"state": "cancelled"})
}
