package cos

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// The chief of staff's system instruction and tool surface, supplied from
// user-editable files rather than only from what is compiled into the binary.
//
// WHY THIS EXISTS. embed.go compiles the sidecar's bundle INTO the muxterm
// binary, which is what makes the chief of staff work on an installed machine
// with no source checkout. It is also what made it untunable: the only way to
// change a word of its instruction was to rebuild. This layers over that
// embedding rather than replacing it -- the compiled-in bundle remains the
// base and remains the whole answer when nothing is configured.
//
// WHY FILES RATHER THAN A [cos] SECTION IN config.toml. Both were open, and
// files are the conservative option, for two independent reasons:
//
//  1. SAFETY (S1). config.toml is writable from a web request -- the browser's
//     PATCH /api/config route, and the update_config MCP tool that the chief of
//     staff itself holds, both land in config.Merge and config.Write. A [cos]
//     section there would be one Merge() line away from the chief of staff
//     editing its own instruction. These files are not part of config.Config at
//     all, so no amount of merging reaches them: the capability does not exist
//     rather than being filtered out.
//
//  2. FITNESS. A system instruction is prose measured in kilobytes. TOML is a
//     poor home for it, and a config file that is rewritten wholesale by
//     config.Write would reformat it on every unrelated browser config change.
//
// The alternative -- a [cos] section -- is recorded here rather than lost, and
// would need Merge() to keep excluding it forever, enforced by nothing.

// Tuning is the effective sidecar configuration: what the NEXT turn will run
// with, and where each part of it came from.
//
// Every value carries its own provenance string. That is the pattern
// resolveAddr (cmd/muxterm/main.go) established for the listen address, and it
// exists for the same reason: an operator who cannot tell a built-in default
// from their own setting gets sent to a file with no answer in it.
type Tuning struct {
	// Instruction is the user's instruction text, EMPTY when they have
	// configured none. It is not the effective system prompt -- the sidecar
	// combines it with the compiled-in bundle instruction according to Mode.
	Instruction string
	// Mode is "append" (default) or "replace".
	Mode string
	// ToolsAllow and ToolsDeny adjust the bundle's own declared surface.
	// Nil means "no opinion"; the bundle's list stands unmodified.
	ToolsAllow []string
	ToolsDeny  []string

	// Provenance, one per value. Always set, never empty.
	InstructionSource string
	ModeSource        string
	ToolsSource       string

	// Dir is the directory these files live in, reported so a user told
	// "built-in default" knows where to put a file to change that.
	Dir string
	// Problems holds non-fatal complaints -- an unreadable file, an
	// unparseable policy, an unknown mode. A tuning that cannot be read
	// falls back to the compiled-in defaults and SAYS SO; it never fails
	// the turn and never silently half-applies.
	Problems []string
}

const (
	// SourceBuiltin is the provenance string for a value nothing configured.
	// Worded to match resolveAddr's "built-in default" exactly.
	SourceBuiltin = "built-in default"

	// InstructionFile and PolicyFile are the two user-editable files, both
	// directly under ConfigDir().
	InstructionFile = "instruction.md"
	PolicyFile      = "policy.toml"

	// ModeAppend keeps the compiled-in charter and adds to it. ModeReplace
	// discards it entirely.
	//
	// APPEND IS THE DEFAULT, deliberately. The compiled-in instruction is the
	// charter that makes the chief of staff a dispatcher rather than a
	// worker; a typo in a tuning file should not be able to silently delete
	// it. Replacing is a one-word opt-in for someone who means it.
	ModeAppend  = "append"
	ModeReplace = "replace"
)

// EnvConfigDir overrides where the tuning files are read from. It exists so a
// development muxterm can be pointed at a throwaway directory without touching
// the real one -- the same role EnvSessionID plays for the transcript.
const EnvConfigDir = "MUXTERM_COS_CONFIG_DIR"

// ConfigDir returns the directory holding the chief of staff's tuning files,
// and where that answer came from.
//
// It follows config.DefaultPath's XDG-with-HOME-fallback shape so the two
// never disagree about where muxterm's configuration lives, and adds a cos/
// subdirectory: these are muxterm's files, but they are not config.toml, and
// nothing that rewrites config.toml may rewrite them.
func ConfigDir() (dir, source string) {
	if v := strings.TrimSpace(os.Getenv(EnvConfigDir)); v != "" {
		return v, "from $" + EnvConfigDir
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "muxterm", "cos"), "XDG default"
}

// policyFile is the on-disk shape of policy.toml. Kept separate from Tuning so
// the wire format and the resolved value are not the same type -- a field
// added to one does not silently become part of the other.
type policyFile struct {
	// InstructionMode selects append (default) or replace.
	InstructionMode string `toml:"instruction_mode"`
	// ToolsAllow ADDS to the bundle's declared surface. Entries may end in
	// "*" to match a prefix, the same syntax the bundle's own list uses.
	ToolsAllow []string `toml:"tools_allow"`
	// ToolsDeny SUBTRACTS, and wins over every allow -- the bundle's and the
	// user's alike. Denying is the direction that can only ever narrow the
	// surface, so it is the one that gets the last word.
	ToolsDeny []string `toml:"tools_deny"`
}

// LoadTuning reads the tuning files out of dir and resolves them against the
// compiled-in defaults.
//
// ONE home for the question "which layer supplied this value". Every caller --
// the supervisor pushing a reconfigure, `muxterm cos config` reporting to a
// human -- goes through here, so the two can never give a user different
// answers about the same file.
//
// An absent directory is the normal case and not an error: it means nothing is
// configured, every value reports SourceBuiltin, and the chief of staff runs
// exactly as it did before this file existed.
func LoadTuning(dir string) Tuning {
	t := Tuning{
		Dir:               dir,
		Mode:              ModeAppend,
		InstructionSource: SourceBuiltin,
		ModeSource:        SourceBuiltin,
		ToolsSource:       SourceBuiltin,
	}

	instPath := filepath.Join(dir, InstructionFile)
	switch data, err := os.ReadFile(instPath); {
	case err == nil:
		// A file present but empty (or only whitespace) is treated as absent
		// rather than as "replace the charter with nothing" -- the second
		// reading turns `: > instruction.md` into a silent lobotomy.
		if text := strings.TrimSpace(string(data)); text != "" {
			t.Instruction = text
			t.InstructionSource = "from " + instPath
		}
	case !os.IsNotExist(err):
		t.Problems = append(t.Problems, fmt.Sprintf("could not read %s: %v", instPath, err))
	}

	polPath := filepath.Join(dir, PolicyFile)
	switch data, err := os.ReadFile(polPath); {
	case err == nil:
		var pf policyFile
		if _, decErr := toml.Decode(string(data), &pf); decErr != nil {
			// LOUD AND INERT. A malformed policy keeps the built-in surface
			// rather than applying half of it: a tool list that half-parses is
			// a safety property decided by where the syntax error happened to
			// land.
			t.Problems = append(t.Problems,
				fmt.Sprintf("could not parse %s (%v); tool policy and instruction mode left at their built-in defaults", polPath, decErr))
			break
		}
		switch strings.TrimSpace(strings.ToLower(pf.InstructionMode)) {
		case "":
			// Unset. Keep the append default and keep saying it is the default.
		case ModeAppend:
			t.Mode, t.ModeSource = ModeAppend, "from "+polPath
		case ModeReplace:
			t.Mode, t.ModeSource = ModeReplace, "from "+polPath
		default:
			t.Problems = append(t.Problems,
				fmt.Sprintf("%s: instruction_mode %q is not %q or %q; using %q",
					polPath, pf.InstructionMode, ModeAppend, ModeReplace, ModeAppend))
		}
		t.ToolsAllow = cleanList(pf.ToolsAllow)
		t.ToolsDeny = cleanList(pf.ToolsDeny)
		if len(t.ToolsAllow) > 0 || len(t.ToolsDeny) > 0 {
			t.ToolsSource = "from " + polPath
		}
	case !os.IsNotExist(err):
		t.Problems = append(t.Problems, fmt.Sprintf("could not read %s: %v", polPath, err))
	}

	return t
}

// cleanList drops blanks and trims each entry, and returns nil rather than an
// empty slice for a list that had nothing usable in it. Nil is what the
// sidecar reads as "no opinion", so the distinction is load-bearing.
func cleanList(in []string) []string {
	var out []string
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Equal reports whether two resolved tunings would produce the same behaviour.
// Provenance strings and Problems are excluded: they change what a human is
// TOLD, never what the sidecar does.
func (t Tuning) Equal(o Tuning) bool {
	return t.Instruction == o.Instruction &&
		t.Mode == o.Mode &&
		sameList(t.ToolsAllow, o.ToolsAllow) &&
		sameList(t.ToolsDeny, o.ToolsDeny)
}

func sameList(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Describe renders the resolved tuning for a human, one value per line with
// the layer that supplied it. This is the answer to C4's "which layer supplied
// each effective value" and is what `muxterm cos config` prints.
func (t Tuning) Describe() string {
	var b strings.Builder
	fmt.Fprintf(&b, "config dir       %s\n", t.Dir)
	fmt.Fprintf(&b, "instruction      %s\n", describeInstruction(t))
	fmt.Fprintf(&b, "instruction mode %s (%s)\n", t.Mode, t.ModeSource)
	fmt.Fprintf(&b, "tools allow +    %s (%s)\n", orNone(t.ToolsAllow), t.ToolsSource)
	fmt.Fprintf(&b, "tools deny  -    %s (%s)\n", orNone(t.ToolsDeny), t.ToolsSource)
	for _, p := range t.Problems {
		fmt.Fprintf(&b, "PROBLEM          %s\n", p)
	}
	return b.String()
}

func describeInstruction(t Tuning) string {
	if t.Instruction == "" {
		return fmt.Sprintf("compiled-in bundle instruction only (%s)", t.InstructionSource)
	}
	verb := "appended to"
	if t.Mode == ModeReplace {
		verb = "REPLACES"
	}
	return fmt.Sprintf("%d chars, %s the compiled-in bundle instruction (%s)",
		len(t.Instruction), verb, t.InstructionSource)
}

func orNone(l []string) string {
	if len(l) == 0 {
		return "(none)"
	}
	return strings.Join(l, ", ")
}
