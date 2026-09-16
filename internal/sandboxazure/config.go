// Package sandboxazure is muxterm's owner-local, direct Azure Sandbox Groups
// lifecycle boundary. It deliberately exposes typed lifecycle operations only;
// it is not an Azure request proxy.
package sandboxazure

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	dataPlaneScope  = "https://dynamicsessions.io/.default"
	RuntimeProtocol = 1
	ingressPort     = 8443
)

var (
	ErrDisabled       = errors.New("direct Azure sandbox is not explicitly enabled")
	ErrKillSwitch     = errors.New("direct Azure sandbox kill switch blocks this operation")
	ErrUnknownProfile = errors.New("direct Azure sandbox profile is not allowlisted")
	ErrBadScope       = errors.New("direct Azure sandbox profile has an invalid allowlisted scope")
)

var safeSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Config is decoded separately by the controller. The corresponding retained
// TOML data is excluded from browser JSON and cannot be modified by browser
// configuration updates.
type Config struct {
	Present    bool      `toml:"-"`
	Enabled    bool      `toml:"enabled"`
	KillSwitch bool      `toml:"kill_switch"`
	StoreDir   string    `toml:"store_dir"`
	Profiles   []Profile `toml:"profile"`
}

// Profile is a closed, operator-authored deployment profile. All scope and
// runtime fields are selected here, never by a CLI/API caller.
type Profile struct {
	Name              string   `toml:"name"`
	TenantID          string   `toml:"tenant_id"`
	SubscriptionID    string   `toml:"subscription_id"`
	ResourceGroup     string   `toml:"resource_group"`
	SandboxGroup      string   `toml:"sandbox_group"`
	Region            string   `toml:"region"`
	DiskID            string   `toml:"disk_id"`
	ImageDigest       string   `toml:"image_digest"`
	ReleaseStatus     string   `toml:"release_status"`
	Protocol          int      `toml:"protocol"`
	CPU               string   `toml:"cpu"`
	Memory            string   `toml:"memory"`
	AutoSuspendSecond int      `toml:"auto_suspend_seconds"`
	AutoDeleteSeconds int      `toml:"auto_delete_seconds"`
	ControllerCIDRs   []string `toml:"controller_cidrs"`
	EgressHosts       []string `toml:"egress_hosts"`
}

// LoadConfig reads only [sandbox_azure] and its [[sandbox_azure.profile]]
// children. An absent section stays disabled; malformed config fails closed.
func LoadConfig(path string) (Config, error) {
	var raw struct {
		SandboxAzure Config `toml:"sandbox_azure"`
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	meta, err := toml.DecodeFile(path, &raw)
	if err != nil {
		return Config{}, fmt.Errorf("read direct Azure sandbox configuration: %w", err)
	}
	raw.SandboxAzure.Present = meta.IsDefined("sandbox_azure")
	if err := raw.SandboxAzure.Validate(); err != nil {
		return Config{}, err
	}
	return raw.SandboxAzure, nil
}

// Availability is the complete configuration truth safe to give a browser.
// It intentionally contains no profile scope, Azure identity, endpoint, or
// credential-related material.
type Availability struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
}

func (c Config) Availability() Availability {
	switch {
	case !c.Present:
		return Availability{State: "unconfigured", Detail: "An owner has not configured Azure Sandboxes on this muxterm."}
	case !c.Enabled:
		return Availability{State: "disabled", Detail: "Azure Sandboxes are configured but disabled by the owner."}
	case c.KillSwitch:
		return Availability{State: "kill-switch", Detail: "The owner kill switch blocks create, resume, and attach. Status and cleanup remain available."}
	default:
		return Availability{State: "ready", Detail: "Azure Sandboxes are available through configured owner profiles."}
	}
}

func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if strings.TrimSpace(c.StoreDir) == "" {
		return errors.New("direct Azure sandbox store_dir is required when enabled")
	}
	if !filepath.IsAbs(c.StoreDir) {
		return errors.New("direct Azure sandbox store_dir must be absolute")
	}
	if len(c.Profiles) == 0 {
		return errors.New("direct Azure sandbox requires at least one allowlisted profile")
	}
	seen := make(map[string]struct{}, len(c.Profiles))
	for _, p := range c.Profiles {
		if _, exists := seen[p.Name]; exists {
			return fmt.Errorf("direct Azure sandbox profile %q is repeated", p.Name)
		}
		seen[p.Name] = struct{}{}
		if err := p.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (p Profile) Validate() error {
	for _, value := range []string{p.Name, p.TenantID, p.SubscriptionID, p.ResourceGroup, p.SandboxGroup, p.Region} {
		if !safeSegment.MatchString(value) {
			return ErrBadScope
		}
	}
	if strings.TrimSpace(p.DiskID) == "" || !strings.Contains(p.DiskID, "/") ||
		!strings.Contains(p.DiskID, "/diskImages/") {
		return errors.New("direct Azure sandbox profile requires a registered private disk_id")
	}
	if !digestReference.MatchString(p.ImageDigest) || p.ReleaseStatus != "active" || p.Protocol != RuntimeProtocol {
		return errors.New("direct Azure sandbox profile lacks an active immutable runtime release")
	}
	if p.CPU == "" || p.Memory == "" || p.AutoSuspendSecond < 60 || p.AutoDeleteSeconds < 300 ||
		p.AutoDeleteSeconds > 86400 || p.AutoDeleteSeconds < p.AutoSuspendSecond {
		return errors.New("direct Azure sandbox profile has invalid runtime values")
	}
	if len(p.ControllerCIDRs) == 0 || len(p.ControllerCIDRs) > 10 {
		return errors.New("direct Azure sandbox profile requires one to ten controller CIDRs")
	}
	for _, cidr := range p.ControllerCIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil || prefix != prefix.Masked() || prefix.Bits() == 0 {
			return errors.New("direct Azure sandbox profile has an invalid controller CIDR")
		}
	}
	if len(p.EgressHosts) > 10 {
		return errors.New("direct Azure sandbox profile permits at most ten egress hosts")
	}
	seenHosts := make(map[string]struct{}, len(p.EgressHosts))
	for _, host := range p.EgressHosts {
		if !validEgressHost(host) {
			return errors.New("direct Azure sandbox profile has an invalid egress host")
		}
		if _, exists := seenHosts[host]; exists {
			return errors.New("direct Azure sandbox profile repeats an egress host")
		}
		seenHosts[host] = struct{}{}
	}
	return nil
}

func (c Config) Profile(name string) (Profile, error) {
	for _, p := range c.Profiles {
		if p.Name == name {
			return p, nil
		}
	}
	return Profile{}, ErrUnknownProfile
}

// Checksum is persisted alongside every record to fence profile edits. The
// canonical field order makes it deterministic across processes and releases.
func (p Profile) Checksum() string {
	parts := []string{
		p.Name, p.TenantID, p.SubscriptionID, p.ResourceGroup, p.SandboxGroup,
		p.Region, p.DiskID, p.ImageDigest, p.ReleaseStatus, fmt.Sprintf("%d", p.Protocol),
		p.CPU, p.Memory, fmt.Sprintf("%d", p.AutoSuspendSecond), fmt.Sprintf("%d", p.AutoDeleteSeconds),
	}
	cidrs := append([]string(nil), p.ControllerCIDRs...)
	sort.Strings(cidrs)
	parts = append(parts, cidrs...)
	hosts := append([]string(nil), p.EgressHosts...)
	sort.Strings(hosts)
	parts = append(parts, hosts...)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

var (
	digestReference = regexp.MustCompile(`^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$`)
	egressHostname  = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$`)
)

// validEgressHost accepts a canonical DNS hostname only. URLs, ports, paths,
// wildcards, userinfo, and literal addresses are all unrepresentable.
func validEgressHost(host string) bool {
	if len(host) == 0 || len(host) > 253 || !egressHostname.MatchString(host) {
		return false
	}
	_, err := netip.ParseAddr(host)
	return err != nil
}
