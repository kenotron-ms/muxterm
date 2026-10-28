package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var remoteChatID = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

type remoteChatSnapshot struct {
	Host     string          `json:"host"`
	Sessions json.RawMessage `json:"sessions,omitempty"`
	Projects json.RawMessage `json:"projects,omitempty"`
	Port     int             `json:"port,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type remoteAppForward struct {
	cmd        *exec.Cmd
	localPort  int
	remotePort int
}

func sshTarget(hostID string) (string, error) {
	if !strings.HasPrefix(hostID, "ssh:") {
		return "", errors.New("remote host must have an ssh: ID")
	}
	target := strings.TrimPrefix(hostID, "ssh:")
	if target == "" || strings.HasPrefix(target, "-") || strings.ContainsAny(target, " \t\r\n/\\'\"`$;|&<>()") {
		return "", errors.New("invalid SSH host")
	}
	return target, nil
}

func (c *Companion) readRemoteChats(hostID string) remoteChatSnapshot {
	snapshot := remoteChatSnapshot{Host: hostID}
	target, err := sshTarget(hostID)
	if err != nil {
		snapshot.Error = err.Error()
		return snapshot
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, "bash -lc 'muxterm mcp'")
	cmd.Stdin = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"desktop_remote_snapshot","arguments":{}}}` + "\n")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		snapshot.Error = fmt.Sprintf("SSH %s: %v: %s", target, err, strings.TrimSpace(stderr.String()))
		return snapshot
	}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		var reply struct {
			ID     int `json:"id"`
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &reply) != nil || reply.ID != 1 {
			continue
		}
		if reply.Error != nil {
			snapshot.Error = reply.Error.Message
			return snapshot
		}
		if len(reply.Result.Content) == 0 {
			break
		}
		var data struct {
			Sessions json.RawMessage `json:"sessions"`
			Projects json.RawMessage `json:"projects"`
			Port     int             `json:"port"`
		}
		if json.Unmarshal([]byte(reply.Result.Content[0].Text), &data) != nil || data.Port < 1 || data.Port > 65535 {
			snapshot.Error = "remote muxterm returned an invalid Chat snapshot"
			return snapshot
		}
		snapshot.Sessions, snapshot.Projects, snapshot.Port = data.Sessions, data.Projects, data.Port
		return snapshot
	}
	snapshot.Error = "remote muxterm did not answer; update it to a version with desktop_remote_snapshot"
	return snapshot
}

func (c *Companion) remoteAppURL(hostID string, remotePort int) (string, error) {
	target, err := sshTarget(hostID)
	if err != nil {
		return "", err
	}
	if remotePort < 1 || remotePort > 65535 {
		return "", errors.New("invalid remote port")
	}
	c.mu.Lock()
	if forward := c.remoteForwards[hostID]; forward != nil && forward.remotePort == remotePort && forward.cmd.ProcessState == nil {
		port := forward.localPort
		c.mu.Unlock()
		return previewURL(port), nil
	}
	c.mu.Unlock()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.Command("ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=8", "-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", port, remotePort), target)
	var log bytes.Buffer
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case err := <-done:
			return "", fmt.Errorf("SSH forward stopped: %v: %s", err, strings.TrimSpace(log.String()))
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			<-done
			return "", fmt.Errorf("SSH forward timed out: %s", strings.TrimSpace(log.String()))
		default:
		}
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			c.mu.Lock()
			if c.remoteForwards == nil {
				c.remoteForwards = make(map[string]*remoteAppForward)
			}
			if old := c.remoteForwards[hostID]; old != nil {
				_ = old.cmd.Process.Kill()
			}
			c.remoteForwards[hostID] = &remoteAppForward{cmd: cmd, localPort: port, remotePort: remotePort}
			c.mu.Unlock()
			return previewURL(port), nil
		}
		time.Sleep(75 * time.Millisecond)
	}
}

func (c *Companion) openRemoteChat(hostID, chatID string) error {
	if !remoteChatID.MatchString(chatID) {
		return errors.New("invalid remote Chat ID")
	}
	snapshot := c.readRemoteChats(hostID)
	if snapshot.Error != "" {
		return errors.New(snapshot.Error)
	}
	var sessions []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(snapshot.Sessions, &sessions); err != nil {
		return errors.New("remote Chat snapshot is invalid")
	}
	found := false
	for _, session := range sessions {
		if session.ID == chatID {
			found = true
			break
		}
	}
	if !found {
		return errors.New("remote Chat is no longer available")
	}
	base, err := c.remoteAppURL(hostID, snapshot.Port)
	if err != nil {
		return err
	}
	address := base + "#chat=" + chatID
	name := "remote-" + hostID
	if window, ok := c.app.Window.GetByName(name); ok {
		window.SetURL(address)
		window.Show()
		window.Focus()
		return nil
	}
	c.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: name, Title: "Muxterm · " + strings.TrimPrefix(hostID, "ssh:"), URL: address,
		Width: 1400, Height: 900, MinWidth: 700, MinHeight: 500,
		BackgroundColour: application.NewRGB(232, 232, 237),
		Mac:              application.MacWindow{TitleBar: application.MacTitleBarHidden},
	})
	return nil
}
