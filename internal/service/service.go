package service

import (
	"bytes"
	"runtime"
	"text/template"
)

var systemdTemplate = template.Must(template.New("systemd").Parse(`[Unit]
Description=muxterm
After=network.target
After=muxterm-sessiond.service
Wants=muxterm-sessiond.service

[Service]
Type=simple
ExecStart={{.BinaryPath}} serve --addr {{.Addr}} --secret {{.Secret}}
Restart=on-failure
RestartSec=5s
Environment=PATH={{.SafePATH}}

[Install]
WantedBy=default.target
`))

var sessiondSystemdTemplate = template.Must(template.New("sessiond-systemd").Parse(`[Unit]
Description=muxterm sessiond (session persistence daemon)
After=network.target

[Service]
Type=simple
ExecStart={{.BinaryPath}} sessiond
Restart=on-failure
RestartSec=5s
Environment=PATH={{.SafePATH}}

[Install]
WantedBy=default.target
`))

var launchdTemplate = template.Must(template.New("launchd").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.muxterm</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{.BinaryPath}}</string>
        <string>serve</string>
        <string>--addr</string>
        <string>{{.Addr}}</string>
        <string>--secret</string>
        <string>{{.Secret}}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{.SafePATH}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/muxterm.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/muxterm.log</string>
</dict>
</plist>
`))

func RenderLaunchdPlist(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := launchdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func RenderSystemdUnit(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := systemdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func RenderSessiondSystemdUnit(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := sessiondSystemdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}

type ServiceConfig struct {
	BinaryPath string
	Addr       string
	Secret     string
	SafePATH   string
}

func DetectPlatform() string {
	return runtime.GOOS
}

func DefaultConfig() ServiceConfig {
	return ServiceConfig{
		Addr: "localhost:8080",
	}
}
