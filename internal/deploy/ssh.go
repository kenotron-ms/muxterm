package deploy

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
)

// Runner abstracts command execution for testability.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// execRunner implements Runner using exec.Command.
type execRunner struct{}

func (e *execRunner) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// Deployer handles deploying muxterm to a remote host via SSH.
type Deployer struct {
	runner     Runner
	binaryPath string
}

// New creates a Deployer using the current binary path.
func New() (*Deployer, error) {
	binPath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("get executable path: %w", err)
	}
	return &Deployer{
		runner:     &execRunner{},
		binaryPath: binPath,
	}, nil
}

// Deploy copies the muxterm binary to the target host, sets up a systemd
// service, and starts it.
func (d *Deployer) Deploy(target string) error {
	// 1. SCP binary to target:/usr/local/bin/muxterm
	if _, err := d.runner.Run("scp", d.binaryPath, target+":/usr/local/bin/muxterm"); err != nil {
		return fmt.Errorf("copy binary: %w", err)
	}

	// 2. SSH chmod +x the binary
	if _, err := d.runner.Run("ssh", target, "chmod", "+x", "/usr/local/bin/muxterm"); err != nil {
		return fmt.Errorf("chmod binary: %w", err)
	}

	// 3. Generate secret
	secret, err := generateSecret()
	if err != nil {
		return fmt.Errorf("generate secret: %w", err)
	}

	// 4. SSH write systemd unit
	unit := systemdUnit(secret, "0.0.0.0:8080")
	writeCmd := fmt.Sprintf("cat > /etc/systemd/system/muxterm.service << 'EOF'\n%s\nEOF", unit)
	if _, err := d.runner.Run("ssh", target, writeCmd); err != nil {
		return fmt.Errorf("write systemd unit: %w", err)
	}

	// 5. SSH systemctl daemon-reload && systemctl enable --now muxterm.service
	if _, err := d.runner.Run("ssh", target, "systemctl daemon-reload && systemctl enable --now muxterm.service"); err != nil {
		return fmt.Errorf("start service: %w", err)
	}

	// 6. Extract hostname from target, print URL and token
	hostname := target
	if parts := strings.SplitN(target, "@", 2); len(parts) == 2 {
		hostname = parts[1]
	}

	log.Printf("muxterm deployed to %s", target)
	log.Printf("URL: http://%s:8080", hostname)
	log.Printf("secret: %s", secret)

	return nil
}

// systemdUnit generates a systemd unit file for the muxterm service.
//
// This is a SECOND, independent unit template -- internal/service renders
// the one used by `muxterm install`. The two are not shared and do not track
// each other; a change to either must be considered for both.
//
// THE PUBLIC ORIGIN IS NOT CARRIED BY THIS UNIT, DELIBERATELY.
//
// public_origin / behind_reverse_proxy are config-file settings, exactly as
// they are for `muxterm install` (see writeInstallServerConfig in
// cmd/muxterm). Do not add --public-origin to the ExecStart below. Three
// reasons, all of which apply here too:
//
//   - Injection: this unit is built with fmt.Sprintf and no escaping at all,
//     and is then shipped over ssh inside a `cat > ... << 'EOF'` heredoc. An
//     operator-supplied origin containing a newline, or `%` (a systemd
//     specifier), or the literal line "EOF" would break out of the value.
//   - Survival: any redeploy overwrites this file wholesale.
//   - Visibility: a flag in ExecStart outranks the config.toml an operator
//     would naturally edit (resolveServerConfig gives flags precedence),
//     with nothing in the config file to say why it is being ignored.
//
// CONSEQUENCE, KNOWN AND UNFIXED HERE: `muxterm deploy` never writes a
// config file on the remote host, so a pushed deployment always starts with
// public_origin unset -- muxterm derives its public URLs from --addr, and a
// browser arriving through a fronting reverse proxy gets redirected to the
// remote's own listen address. Configuring a public origin on a deploy
// target is a MANUAL step on that host.
//
// Note also that this unit is a SYSTEM unit with no User=, so it runs as
// root, and systemd sets $HOME only for units that set User= (systemd.exec).
// With $HOME unset, config.DefaultPath() resolves to the RELATIVE path
// ".config/muxterm/config.toml", taken against the system manager's default
// WorkingDirectory of "/" -- i.e. /.config/muxterm/config.toml, not
// /root/.config/... . Any manual remote configuration has to account for
// that (write the file there, or add User= / Environment=XDG_CONFIG_HOME=
// to this unit) or the file will be silently ignored.
func systemdUnit(secret, addr string) string {
	return fmt.Sprintf(`[Unit]
Description=muxterm remote terminal
After=network.target

[Service]
ExecStart=/usr/local/bin/muxterm serve --addr %s --secret %s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`, addr, secret)
}

// generateSecret generates a 16-byte random hex-encoded secret.
func generateSecret() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
