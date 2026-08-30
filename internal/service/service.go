package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"text/template"
	"unicode"
)

var systemdTemplateFuncs = template.FuncMap{
	"systemdArg": escapeSystemdArgument,
	"systemdEnv": escapeSystemdEnvironment,
}

var launchdTemplateFuncs = template.FuncMap{
	"logPath": serviceLogPath,
	"xml":     escapeXMLText,
}

const (
	webStdoutLogName      = "muxterm.stdout.log"
	webStderrLogName      = "muxterm.stderr.log"
	sessiondStdoutLogName = "sessiond.stdout.log"
	sessiondStderrLogName = "sessiond.stderr.log"
)

var systemdTemplate = template.Must(template.New("systemd").Funcs(systemdTemplateFuncs).Parse(`[Unit]
Description=muxterm
After=network.target
After=muxterm-sessiond.service
Wants=muxterm-sessiond.service

[Service]
Type=simple
ExecStart={{systemdArg .BinaryPath}} serve --addr {{systemdArg .Addr}} --secret {{systemdArg .Secret}}
Restart=on-failure
RestartSec=5s
Environment={{systemdEnv "PATH" .SafePATH}}
Environment={{systemdEnv "XDG_RUNTIME_DIR" .RuntimeDir}}
Environment={{systemdEnv "XDG_STATE_HOME" .StateDir}}

[Install]
WantedBy=default.target
`))

var sessiondSystemdTemplate = template.Must(template.New("sessiond-systemd").Funcs(systemdTemplateFuncs).Parse(`[Unit]
Description=muxterm sessiond (session persistence daemon)
After=network.target
StartLimitIntervalSec=30s
StartLimitBurst=5

[Service]
Type=simple
ExecStart={{systemdArg .BinaryPath}} sessiond
Restart=on-failure
RestartSec=1s
UMask=0077
RuntimeDirectory=muxterm
RuntimeDirectoryMode=0700
StateDirectory=muxterm
StateDirectoryMode=0700
Environment={{systemdEnv "PATH" .SafePATH}}
Environment={{systemdEnv "XDG_RUNTIME_DIR" .RuntimeDir}}
Environment={{systemdEnv "XDG_STATE_HOME" .StateDir}}

[Install]
WantedBy=default.target
`))

var launchdTemplate = template.Must(template.New("launchd").Funcs(launchdTemplateFuncs).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.muxterm</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{xml .BinaryPath}}</string>
        <string>serve</string>
        <string>--addr</string>
        <string>{{xml .Addr}}</string>
        <string>--secret</string>
        <string>{{xml .Secret}}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{xml .SafePATH}}</string>
        <key>XDG_RUNTIME_DIR</key>
        <string>{{xml .RuntimeDir}}</string>
        <key>XDG_STATE_HOME</key>
        <string>{{xml .StateDir}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>{{xml (logPath .LogDir "` + webStdoutLogName + `")}}</string>
    <key>StandardErrorPath</key>
    <string>{{xml (logPath .LogDir "` + webStderrLogName + `")}}</string>
</dict>
</plist>
`))

var sessiondLaunchdTemplate = template.Must(template.New("sessiond-launchd").Funcs(launchdTemplateFuncs).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.muxterm.sessiond</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{xml .BinaryPath}}</string>
        <string>sessiond</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{xml .SafePATH}}</string>
        <key>XDG_RUNTIME_DIR</key>
        <string>{{xml .RuntimeDir}}</string>
        <key>XDG_STATE_HOME</key>
        <string>{{xml .StateDir}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>{{xml (logPath .LogDir "` + sessiondStdoutLogName + `")}}</string>
    <key>StandardErrorPath</key>
    <string>{{xml (logPath .LogDir "` + sessiondStderrLogName + `")}}</string>
</dict>
</plist>
`))

func RenderLaunchdPlist(cfg ServiceConfig) (string, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := launchdTemplate.Execute(&buf, normalized); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func RenderSessiondLaunchdPlist(cfg ServiceConfig) (string, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := sessiondLaunchdTemplate.Execute(&buf, normalized); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func RenderSystemdUnit(cfg ServiceConfig) (string, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := systemdTemplate.Execute(&buf, normalized); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func RenderSessiondSystemdUnit(cfg ServiceConfig) (string, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := sessiondSystemdTemplate.Execute(&buf, normalized); err != nil {
		return "", err
	}
	return buf.String(), nil
}

type ServiceConfig struct {
	BinaryPath string
	Addr       string
	Secret     string
	SafePATH   string
	RuntimeDir string
	StateDir   string
	LogDir     string
	Force      bool // permit controlled replacement; never authorize a blind stop
}

// sessiondSocketPath derives the immutable daemon socket location from a
// normalized service configuration.
func sessiondSocketPath(config ServiceConfig) string {
	return filepath.Join(config.RuntimeDir, "muxterm", "sessiond.sock")
}

func normalizeServiceConfig(cfg ServiceConfig) (ServiceConfig, error) {
	if cfg.BinaryPath == "" {
		executable, err := os.Executable()
		if err != nil {
			return ServiceConfig{}, fmt.Errorf("resolve binary path: %w", err)
		}
		cfg.BinaryPath = executable
	}
	if cfg.SafePATH == "" {
		cfg.SafePATH = os.Getenv("PATH")
	}

	switch DetectPlatform() {
	case "linux":
		if cfg.RuntimeDir == "" {
			cfg.RuntimeDir = os.Getenv("XDG_RUNTIME_DIR")
			if cfg.RuntimeDir == "" {
				cfg.RuntimeDir = filepath.Join("/run", "user", fmt.Sprintf("%d", os.Getuid()))
			}
		}

		stateHome := os.Getenv("XDG_STATE_HOME")
		needsHome := cfg.LogDir == "" || (cfg.StateDir == "" && stateHome == "")
		var home string
		if needsHome {
			var err error
			home, err = os.UserHomeDir()
			if err != nil {
				return ServiceConfig{}, fmt.Errorf("resolve home directory: %w", err)
			}
		}
		if cfg.StateDir == "" {
			if stateHome != "" {
				cfg.StateDir = stateHome
			} else {
				cfg.StateDir = filepath.Join(home, ".local", "state")
			}
		}
		if cfg.LogDir == "" {
			cfg.LogDir = filepath.Join(home, ".local", "state", "muxterm", "log")
		}
	case "darwin":
		if cfg.RuntimeDir == "" || cfg.StateDir == "" || cfg.LogDir == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return ServiceConfig{}, fmt.Errorf("resolve home directory: %w", err)
			}
			if cfg.RuntimeDir == "" {
				cfg.RuntimeDir = filepath.Join(home, "Library", "Caches")
			}
			if cfg.StateDir == "" {
				cfg.StateDir = filepath.Join(home, "Library", "Application Support", "muxterm", "state")
			}
			if cfg.LogDir == "" {
				cfg.LogDir = filepath.Join(home, "Library", "Logs", "muxterm")
			}
		}
	default:
		return ServiceConfig{}, fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}

	renderedValues := []struct {
		name  string
		value string
	}{
		{name: "binary path", value: cfg.BinaryPath},
		{name: "address", value: cfg.Addr},
		{name: "secret", value: cfg.Secret},
		{name: "safe PATH", value: cfg.SafePATH},
		{name: "runtime directory", value: cfg.RuntimeDir},
		{name: "state directory", value: cfg.StateDir},
		{name: "log directory", value: cfg.LogDir},
	}
	for _, field := range renderedValues {
		if strings.ContainsAny(field.value, "\x00\r\n") {
			return ServiceConfig{}, fmt.Errorf("%s contains a prohibited control character", field.name)
		}
	}

	absolutePaths := []struct {
		name  string
		value string
	}{
		{name: "binary path", value: cfg.BinaryPath},
		{name: "runtime directory", value: cfg.RuntimeDir},
		{name: "state directory", value: cfg.StateDir},
		{name: "log directory", value: cfg.LogDir},
	}
	for _, field := range absolutePaths {
		if field.value == "" {
			return ServiceConfig{}, fmt.Errorf("%s must not be empty", field.name)
		}
		if !filepath.IsAbs(field.value) {
			return ServiceConfig{}, fmt.Errorf("%s must be absolute", field.name)
		}
	}
	if !filepath.IsAbs(sessiondSocketPath(cfg)) {
		return ServiceConfig{}, fmt.Errorf("sessiond socket path must be absolute")
	}

	return cfg, nil
}

func escapeSystemdArgument(value string) string {
	return quoteSystemdWord(strings.ReplaceAll(value, "$", "$$"))
}

func escapeSystemdEnvironment(name, value string) string {
	return quoteSystemdWord(name + "=" + value)
}

func quoteSystemdWord(value string) string {
	escaped := strings.ReplaceAll(value, "%", "%%")
	if value != "" && !strings.ContainsFunc(value, systemdWordNeedsQuoting) {
		return escaped
	}
	return strconv.Quote(escaped)
}

func systemdWordNeedsQuoting(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune(`"'\\%$`, r)
}

func escapeXMLText(value string) (string, error) {
	var escaped bytes.Buffer
	if err := xml.EscapeText(&escaped, []byte(value)); err != nil {
		return "", err
	}
	return escaped.String(), nil
}

func serviceLogPath(logDir, name string) string {
	return filepath.Join(logDir, name)
}

func DetectPlatform() string {
	return runtime.GOOS
}

func DefaultConfig() ServiceConfig {
	return ServiceConfig{
		Addr: "0.0.0.0:8311",
	}
}
