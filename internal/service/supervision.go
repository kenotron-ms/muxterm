package service

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const (
	sessiondReadinessPollInterval = 100 * time.Millisecond
	sessiondReadinessTimeout      = 10 * time.Second
	sessiondProbeRequestTimeout   = time.Second
	sessiondProbeMaxFrameBytes    = 1 << 20
	sessiondProbeListCID          = 1
	sessiondProbeHelloCID         = 2
)

var launchdPIDLine = regexp.MustCompile(`^[\t ]*pid = ([1-9][0-9]*)$`)
var errSessiondNotInstalled = errors.New("muxterm sessiond is not registered")

type DaemonIdentity struct {
	PID int
}

type ReadinessRequirement uint8

const (
	SessiondProtocolReady ReadinessRequirement = iota
	SessiondRecoveryCompatible
)

type SessiondProbe interface {
	Probe(ctx context.Context, socketPath string, requirement ReadinessRequirement) error
}

type Supervisor interface {
	SessiondIdentity(context.Context) (DaemonIdentity, error)
	EnableSessiond(context.Context) error
	StartSessiond(context.Context) error
	RestartSessiond(context.Context) error
	StartOrRestartWeb(context.Context, bool) error
}

type linuxSupervisor struct {
	command Commander
}

func newLinuxSupervisor(command Commander) *linuxSupervisor {
	return &linuxSupervisor{command: command}
}

func (supervisor *linuxSupervisor) SessiondIdentity(ctx context.Context) (DaemonIdentity, error) {
	result, err := supervisor.command.Run(
		ctx,
		"systemctl",
		"--user",
		"show",
		"--property=MainPID",
		"--value",
		"muxterm-sessiond.service",
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return DaemonIdentity{}, fmt.Errorf("query systemd sessiond identity: %w", ctxErr)
		}
		if systemdSessiondRegistrationAbsent(result) {
			return DaemonIdentity{}, errSessiondNotInstalled
		}
		return DaemonIdentity{}, fmt.Errorf("query systemd sessiond identity: %w", err)
	}
	if result.ExitCode != 0 {
		return DaemonIdentity{}, fmt.Errorf(
			"query systemd sessiond identity returned unexpected status %d",
			result.ExitCode,
		)
	}
	pid, err := parsePositiveDecimalLine(result)
	if err != nil {
		return DaemonIdentity{}, fmt.Errorf("parse systemd sessiond identity: %w", err)
	}
	return DaemonIdentity{PID: pid}, nil
}

func systemdSessiondRegistrationAbsent(result CommandResult) bool {
	return result.ExitCode == 1 &&
		!result.StdoutTruncated &&
		!result.StderrTruncated &&
		len(result.Stdout) == 0 &&
		string(result.Stderr) == "Unit muxterm-sessiond.service could not be found.\n"
}

func (supervisor *linuxSupervisor) EnableSessiond(ctx context.Context) error {
	return supervisor.run(ctx, "enable sessiond", "enable", "muxterm-sessiond.service")
}

func (supervisor *linuxSupervisor) StartSessiond(ctx context.Context) error {
	return supervisor.run(ctx, "start sessiond", "start", "muxterm-sessiond.service")
}

func (supervisor *linuxSupervisor) RestartSessiond(ctx context.Context) error {
	return supervisor.run(ctx, "restart sessiond", "restart", "muxterm-sessiond.service")
}

func (supervisor *linuxSupervisor) StartOrRestartWeb(ctx context.Context, restart bool) error {
	if restart {
		return supervisor.run(ctx, "restart web", "restart", "muxterm.service")
	}
	if err := supervisor.run(ctx, "enable web", "enable", "muxterm.service"); err != nil {
		return err
	}
	return supervisor.run(ctx, "start web", "start", "muxterm.service")
}

func (supervisor *linuxSupervisor) run(ctx context.Context, operation string, args ...string) error {
	if _, err := supervisor.command.Run(ctx, "systemctl", append([]string{"--user"}, args...)...); err != nil {
		return fmt.Errorf("systemctl %s: %w", operation, err)
	}
	return nil
}

type darwinSupervisor struct {
	command               Commander
	domain                string
	webPlistPath          string
	sessiondPlistPath     string
	webServiceTarget      string
	sessiondServiceTarget string
}

func newDarwinSupervisor(
	command Commander,
	uid int,
	webPlistPath string,
	sessiondPlistPath string,
) *darwinSupervisor {
	domain := "gui/" + strconv.Itoa(uid)
	return &darwinSupervisor{
		command:               command,
		domain:                domain,
		webPlistPath:          webPlistPath,
		sessiondPlistPath:     sessiondPlistPath,
		webServiceTarget:      domain + "/com.muxterm",
		sessiondServiceTarget: domain + "/com.muxterm.sessiond",
	}
}

func (supervisor *darwinSupervisor) SessiondIdentity(ctx context.Context) (DaemonIdentity, error) {
	result, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"print",
		supervisor.sessiondServiceTarget,
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return DaemonIdentity{}, fmt.Errorf("query launchd sessiond identity: %w", ctxErr)
		}
		if supervisor.sessiondRegistrationAbsent(result) {
			return DaemonIdentity{}, errSessiondNotInstalled
		}
		return DaemonIdentity{}, fmt.Errorf("query launchd sessiond identity: %w", err)
	}
	if result.ExitCode != 0 {
		return DaemonIdentity{}, fmt.Errorf(
			"query launchd sessiond identity returned unexpected status %d",
			result.ExitCode,
		)
	}
	pid, err := parseLaunchdPID(result)
	if err != nil {
		return DaemonIdentity{}, fmt.Errorf("parse launchd sessiond identity: %w", err)
	}
	return DaemonIdentity{PID: pid}, nil
}

func (*darwinSupervisor) EnableSessiond(context.Context) error {
	// launchd has no enable operation separate from bootstrap. StartSessiond
	// performs that one registration, and RunAtLoad starts the registered job.
	return nil
}

func (supervisor *darwinSupervisor) StartSessiond(ctx context.Context) error {
	result, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"print",
		supervisor.sessiondServiceTarget,
	)
	if err == nil {
		// Registration is independent of whether launchd currently reports a
		// running PID. A registered KeepAlive job must not be bootstrapped or
		// kicked merely because it is between process instances.
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("launchctl inspect sessiond registration: %w", ctxErr)
	}
	if !supervisor.sessiondRegistrationAbsent(result) {
		return fmt.Errorf("launchctl inspect sessiond registration: %w", err)
	}

	if _, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"bootstrap",
		supervisor.domain,
		supervisor.sessiondPlistPath,
	); err != nil {
		return fmt.Errorf("launchctl bootstrap sessiond: %w", err)
	}
	return nil
}

func (supervisor *darwinSupervisor) sessiondRegistrationAbsent(result CommandResult) bool {
	if result.ExitCode != 113 ||
		result.StdoutTruncated ||
		result.StderrTruncated ||
		len(result.Stdout) != 0 {
		return false
	}

	uid := strings.TrimPrefix(supervisor.domain, "gui/")
	expected := fmt.Sprintf(
		"Could not find service %q in domain for user gui: %s",
		"com.muxterm.sessiond",
		uid,
	)
	return string(result.Stderr) == expected+"\n" ||
		string(result.Stderr) == "Bad request.\n"+expected+"\n"
}

func (supervisor *darwinSupervisor) RestartSessiond(ctx context.Context) error {
	if _, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"bootout",
		supervisor.sessiondServiceTarget,
	); err != nil {
		return fmt.Errorf("launchctl bootout sessiond for committed replacement: %w", err)
	}
	if _, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"bootstrap",
		supervisor.domain,
		supervisor.sessiondPlistPath,
	); err != nil {
		return fmt.Errorf("launchctl bootstrap sessiond for committed replacement: %w", err)
	}
	return nil
}

func (supervisor *darwinSupervisor) StartOrRestartWeb(ctx context.Context, restart bool) error {
	if restart {
		if _, err := supervisor.command.Run(
			ctx,
			"launchctl",
			"kickstart",
			"-k",
			supervisor.webServiceTarget,
		); err != nil {
			return fmt.Errorf("launchctl restart web: %w", err)
		}
		return nil
	}
	if _, err := supervisor.command.Run(
		ctx,
		"launchctl",
		"bootstrap",
		supervisor.domain,
		supervisor.webPlistPath,
	); err != nil {
		return fmt.Errorf("launchctl bootstrap web: %w", err)
	}
	return nil
}

func parsePositiveDecimalLine(result CommandResult) (int, error) {
	if result.StdoutTruncated {
		return 0, fmt.Errorf("identity output was truncated")
	}
	line := string(result.Stdout)
	if strings.HasSuffix(line, "\n") {
		line = strings.TrimSuffix(line, "\n")
	}
	if line == "" || strings.ContainsAny(line, "\r\n") {
		return 0, fmt.Errorf("identity output is not exactly one line")
	}
	for _, char := range line {
		if char < '0' || char > '9' {
			return 0, fmt.Errorf("identity is not a positive decimal PID")
		}
	}
	pid, err := strconv.Atoi(line)
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("identity is not a positive decimal PID")
	}
	return pid, nil
}

func parseLaunchdPID(result CommandResult) (int, error) {
	if result.StdoutTruncated {
		return 0, fmt.Errorf("identity output was truncated")
	}
	var pid int
	matches := 0
	for _, line := range strings.Split(string(result.Stdout), "\n") {
		match := launchdPIDLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		parsed, err := strconv.Atoi(match[1])
		if err != nil || parsed <= 0 {
			return 0, fmt.Errorf("identity is not a positive decimal PID")
		}
		pid = parsed
		matches++
	}
	if matches != 1 {
		return 0, fmt.Errorf("expected exactly one anchored pid field, got %d", matches)
	}
	return pid, nil
}

type protocolSessiondProbe struct{}

func (*protocolSessiondProbe) Probe(
	ctx context.Context,
	socketPath string,
	requirement ReadinessRequirement,
) error {
	if requirement != SessiondProtocolReady && requirement != SessiondRecoveryCompatible {
		return fmt.Errorf("unknown sessiond readiness requirement %d", requirement)
	}

	attemptCtx, cancel := context.WithTimeout(ctx, sessiondProbeRequestTimeout)
	defer cancel()

	connection, err := (&net.Dialer{}).DialContext(attemptCtx, "unix", socketPath)
	if err != nil {
		return sessiondProbeOperationError(attemptCtx, "dial sessiond socket", err)
	}
	closeDone := make(chan struct{})
	stopCancellationClose := context.AfterFunc(attemptCtx, func() {
		_ = connection.Close()
		close(closeDone)
	})
	defer func() {
		if !stopCancellationClose() {
			<-closeDone
		}
		_ = connection.Close()
	}()

	deadline, ok := attemptCtx.Deadline()
	if !ok {
		return fmt.Errorf("sessiond probe context has no deadline")
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return sessiondProbeOperationError(attemptCtx, "set sessiond probe deadline", err)
	}

	if err := sessiond.WriteControl(connection, &sessiond.Message{
		Type: sessiond.TypeListWorkspaces,
		CID:  sessiondProbeListCID,
	}); err != nil {
		return sessiondProbeOperationError(attemptCtx, "write list-workspaces request", err)
	}
	if _, err := readSessiondProbeReply(
		attemptCtx,
		connection,
		sessiondProbeListCID,
		sessiond.TypeWorkspaceList,
	); err != nil {
		return fmt.Errorf("read list-workspaces response: %w", err)
	}

	if requirement == SessiondRecoveryCompatible {
		hello := sessiond.ProtocolHelloRequest{
			RecoverySchemaVersion: sessiond.RecoveryCaptureSchemaVersion,
			Capabilities: sessiond.RecoveryProtocolCapabilities{
				Values: []sessiond.RecoveryProtocolCapability{},
			},
		}
		if err := sessiond.ValidateRecoveryContract(hello); err != nil {
			return fmt.Errorf("validate protocol-hello request: %w", err)
		}
		if err := sessiond.WriteControl(connection, &sessiond.Message{
			Type:          sessiond.TypeProtocolHello,
			CID:           sessiondProbeHelloCID,
			ProtocolHello: &hello,
		}); err != nil {
			return sessiondProbeOperationError(attemptCtx, "write protocol-hello request", err)
		}
		reply, err := readSessiondProbeReply(
			attemptCtx,
			connection,
			sessiondProbeHelloCID,
			sessiond.TypeProtocolHelloResult,
		)
		if err != nil {
			return fmt.Errorf("read protocol-hello response: %w", err)
		}
		if reply.ProtocolHelloResult == nil {
			return fmt.Errorf("protocol-hello response has no result")
		}
		result := *reply.ProtocolHelloResult
		if err := sessiond.ValidateRecoveryContract(result); err != nil {
			return fmt.Errorf("validate protocol-hello result: %w", err)
		}
		if result.RecoverySchemaVersion != sessiond.RecoveryCaptureSchemaVersion {
			return fmt.Errorf(
				"sessiond recovery schema is %d, expected %d",
				result.RecoverySchemaVersion,
				sessiond.RecoveryCaptureSchemaVersion,
			)
		}
		if !result.Compatible {
			return fmt.Errorf("sessiond recovery protocol is incompatible")
		}
	}

	return attemptCtx.Err()
}

func readSessiondProbeReply(
	ctx context.Context,
	connection net.Conn,
	expectedCID uint64,
	expectedType string,
) (*sessiond.Message, error) {
	kind, payload, err := sessiond.ReadFrame(&boundedSessiondFrameReader{reader: connection})
	if err != nil {
		return nil, sessiondProbeOperationError(ctx, "read sessiond frame", err)
	}
	if kind != sessiond.FrameControl {
		return nil, fmt.Errorf("sessiond response frame kind is %#x, expected control", kind)
	}

	var envelope struct {
		Type  string `json:"type"`
		CID   uint64 `json:"cid"`
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, fmt.Errorf("decode sessiond control response: %w", err)
	}
	if envelope.CID != expectedCID {
		return nil, fmt.Errorf(
			"sessiond response CID is %d, expected %d",
			envelope.CID,
			expectedCID,
		)
	}
	if envelope.Type == sessiond.TypeError {
		return nil, fmt.Errorf("sessiond returned protocol error code %q", envelope.Code)
	}
	if envelope.Type != expectedType {
		return nil, fmt.Errorf(
			"sessiond response type is %q, expected %q",
			envelope.Type,
			expectedType,
		)
	}
	if envelope.Code != "" || envelope.Error != "" {
		return nil, fmt.Errorf("sessiond response contains protocol error fields")
	}

	if expectedType == sessiond.TypeProtocolHelloResult {
		validated, err := sessiond.DecodeBrowserRecoveryMessage(payload)
		if err != nil {
			return nil, fmt.Errorf("validate protocol-hello envelope: %w", err)
		}
		return validated, nil
	}
	return &sessiond.Message{
		Type: expectedType,
		CID:  expectedCID,
	}, nil
}

type boundedSessiondFrameReader struct {
	reader     io.Reader
	headerRead bool
}

func (reader *boundedSessiondFrameReader) Read(buffer []byte) (int, error) {
	if reader.headerRead {
		return reader.reader.Read(buffer)
	}
	if len(buffer) != 4 {
		return 0, fmt.Errorf("sessiond frame reader expected a four-byte header")
	}

	var header [4]byte
	if _, err := io.ReadFull(reader.reader, header[:]); err != nil {
		return 0, err
	}
	total := binary.BigEndian.Uint32(header[:])
	if total > sessiondProbeMaxFrameBytes {
		return 0, fmt.Errorf(
			"sessiond frame length %d exceeds readiness limit %d",
			total,
			sessiondProbeMaxFrameBytes,
		)
	}
	copy(buffer, header[:])
	reader.headerRead = true
	return len(header), nil
}

func sessiondProbeOperationError(ctx context.Context, operation string, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("%s: %w", operation, ctxErr)
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func waitForSessiond(
	ctx context.Context,
	supervisor Supervisor,
	probe SessiondProbe,
	socketPath string,
	previous *DaemonIdentity,
	requirement ReadinessRequirement,
) (DaemonIdentity, error) {
	if supervisor == nil {
		return DaemonIdentity{}, fmt.Errorf("wait for sessiond readiness: supervisor is nil")
	}
	if probe == nil {
		return DaemonIdentity{}, fmt.Errorf("wait for sessiond readiness: probe is nil")
	}
	waitCtx, cancel := boundedSessiondContext(ctx, sessiondReadinessTimeout)
	defer cancel()

	var lastErr error
	for {
		if err := waitCtx.Err(); err != nil {
			return DaemonIdentity{}, readinessWaitError(err, lastErr)
		}

		identity, err := supervisor.SessiondIdentity(waitCtx)
		switch {
		case err != nil:
			lastErr = err
		case identity.PID <= 0:
			lastErr = fmt.Errorf("supervisor reported a non-positive sessiond PID")
		case previous != nil && identity.PID == previous.PID:
			lastErr = fmt.Errorf("supervisor still reports the previous sessiond PID")
		default:
			if err := probe.Probe(waitCtx, socketPath, requirement); err == nil {
				if err := waitCtx.Err(); err == nil {
					return identity, nil
				} else {
					lastErr = err
				}
			} else {
				lastErr = err
			}
		}

		timer := time.NewTimer(sessiondReadinessPollInterval)
		select {
		case <-waitCtx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return DaemonIdentity{}, readinessWaitError(waitCtx.Err(), lastErr)
		case <-timer.C:
		}
	}
}

func boundedSessiondContext(ctx context.Context, maximum time.Duration) (context.Context, context.CancelFunc) {
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= maximum {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, maximum)
}

func readinessWaitError(ctxErr, lastErr error) error {
	if lastErr == nil {
		return fmt.Errorf("wait for sessiond readiness: %w", ctxErr)
	}
	return fmt.Errorf("wait for sessiond readiness: %w (last observation: %v)", ctxErr, lastErr)
}

func prepareLaunchdOwnedPaths(cfg ServiceConfig) error {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return err
	}
	ownedDirectories := []string{
		filepath.Dir(sessiondSocketPath(normalized)),
		normalized.StateDir,
		normalized.LogDir,
	}
	for _, directory := range ownedDirectories {
		if err := ensureLaunchdOwnedDirectory(directory); err != nil {
			return err
		}
	}

	for _, name := range []string{
		webStdoutLogName,
		webStderrLogName,
		sessiondStdoutLogName,
		sessiondStderrLogName,
	} {
		path := serviceLogPath(normalized.LogDir, name)
		if info, err := os.Lstat(path); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				return fmt.Errorf("service log must be a regular file: %s", path)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect service log %s: %w", path, err)
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return fmt.Errorf("precreate service log %s: %w", path, err)
		}
		if err := file.Chmod(0o600); err != nil {
			if closeErr := file.Close(); closeErr != nil {
				return fmt.Errorf("close service log %s after chmod failure: %w", path, closeErr)
			}
			return fmt.Errorf("secure service log %s: %w", path, err)
		}
		if err := file.Close(); err != nil {
			return fmt.Errorf("close service log %s: %w", path, err)
		}
	}
	return nil
}

func ensureLaunchdOwnedDirectory(directory string) error {
	clean := filepath.Clean(directory)
	if !filepath.IsAbs(clean) {
		return fmt.Errorf("muxterm-owned directory must be absolute: %s", directory)
	}

	volume := filepath.VolumeName(clean)
	remainder := strings.TrimPrefix(clean, volume)
	remainder = strings.TrimPrefix(remainder, string(os.PathSeparator))
	components := strings.Split(remainder, string(os.PathSeparator))
	ownedStart := -1
	for index, component := range components {
		if component == "muxterm" {
			ownedStart = index
		}
	}
	if ownedStart == -1 {
		return fmt.Errorf("muxterm-owned directory has no muxterm-owned leaf: %s", directory)
	}

	current := volume + string(os.PathSeparator)
	for index, component := range components {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if index < ownedStart {
				return fmt.Errorf("caller-supplied parent directory does not exist: %s", current)
			}
			if err := os.Mkdir(current, 0o700); err != nil && !os.IsExist(err) {
				return fmt.Errorf("create muxterm-owned directory %s: %w", current, err)
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return fmt.Errorf("inspect directory %s: %w", current, err)
		}
		if index < ownedStart {
			followed, err := os.Stat(current)
			if err != nil {
				return fmt.Errorf("inspect caller-supplied parent directory %s: %w", current, err)
			}
			if !followed.IsDir() {
				return fmt.Errorf("caller-supplied parent path is not a directory: %s", current)
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("directory must not be a symbolic link: %s", current)
		}
		if !info.IsDir() {
			return fmt.Errorf("path is not a directory: %s", current)
		}
		if index >= ownedStart {
			if err := os.Chmod(current, 0o700); err != nil {
				return fmt.Errorf("secure muxterm-owned directory %s: %w", current, err)
			}
		}
	}
	return nil
}

func writeServiceDefinition(path string, content []byte, mode os.FileMode) error {
	if mode != 0o600 && mode != 0o644 {
		return fmt.Errorf("unsupported service definition mode %#o", mode)
	}
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary service definition: %w", err)
	}
	temporaryPath := file.Name()
	renamed := false
	defer func() {
		_ = file.Close()
		if !renamed {
			_ = os.Remove(temporaryPath)
		}
	}()

	if _, err := io.Copy(file, bytes.NewReader(content)); err != nil {
		return fmt.Errorf("write temporary service definition: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync temporary service definition: %w", err)
	}
	if err := file.Chmod(mode); err != nil {
		return fmt.Errorf("set temporary service definition mode: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync temporary service definition mode: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close temporary service definition: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace service definition: %w", err)
	}
	renamed = true

	parent, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open service definition directory: %w", err)
	}
	defer parent.Close()
	if err := parent.Sync(); err != nil {
		return fmt.Errorf("sync service definition directory: %w", err)
	}
	return nil
}
