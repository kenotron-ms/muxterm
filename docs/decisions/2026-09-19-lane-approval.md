# Lane approval belongs to muxterm

New Codex and Claude lanes default to prompting, even if the harness's own
user settings previously enabled bypass. Opt in in muxterm's config file
(`$XDG_CONFIG_HOME/muxterm/config.toml`, otherwise `~/.config/muxterm/config.toml`):

```toml
[lanes]
approval = "never"
```

`prompt` is the default and the only other value. This is an owner setting:
browser preference saves reread and preserve it from disk but cannot change it.
Unreadable config files are not overwritten by preference saves. sessiond reads it
on each launch, so no daemon restart is needed. Existing lanes retain their
policy. A missing config uses `prompt`; malformed config or an invalid value
refuses new supported lanes, including when a per-call override was supplied.

| Policy | Codex | Claude Code |
| --- | --- | --- |
| `prompt` | `-c approval_policy=on-request -c sandbox_mode=workspace-write` | `--permission-mode default` |
| `never` | `-c approval_policy=never -c sandbox_mode=danger-full-access` | `--dangerously-skip-permissions` |

Prompting mode means normal harness approval rules apply; it does not force a
prompt for every command or erase pre-existing allow rules. `never` removes the
Codex sandbox as well as approval prompts. It should only be enabled deliberately.
No harness dotfile is edited. Amplifier has no translation and remains unchanged.

MCP `spawn_lane` accepts optional `approval: "prompt" | "never"`. Omit it to
inherit the destination daemon's config. The CLI equivalent is
`muxterm spawn-lane NAME --harness codex --prompt '...' --approval prompt`.
An explicit override for Amplifier is rejected rather than ignored.

Policy is applied at sessiond's create-pane boundary, after the existing lane
argv builder (including the Codex notify hook), and at trigger firing. Browser,
MCP, CLI, and triggered lanes therefore share the translation. New direct
Codex/Claude create-pane commands also receive it. Competing raw command options
are rejected, with Codex's notify override allowed; use `spawn_lane` for a
canonical launch. Commands typed into an existing shell are outside this seam.
Restore replays the saved argv, retaining that session's policy.

## Failure detection and limits

Before creating a process, sessiond resolves the executable and checks its
`--version` against an exact verified allowlist: **codex-cli 0.155.1** and
**Claude Code 2.1.277**. It then invokes the translated flags with `--help` to
check command-line acceptance. Each probe has a five-second timeout. Version,
parser, timeout, and config failures return a `pane-spawn-failed` error to the
caller; trigger failures use the existing failed-fire reporting. There is no
retry with policy flags removed. The CLI/MCP failed-spawn cleanup removes a
workspace created by that failed call.

The exact version gate is intentionally conservative: even a harmless harness
update requires a new live verification and an allowlist update. Claude 2.1.276
is not allowlisted because this verification host currently reports 2.1.277.
Codex accepts arbitrary `-c` keys, so a successful `--help` alone cannot detect a
renamed or ignored config key. The version gate prevents blindly trusting those
keys on a newer release. Version pins live beside the translation.

This does not attest binary contents: a modified binary reporting the same
version, an executable replaced between probe and exec, or a same-version
semantic regression can evade it. Nor does it prove every later runtime
permission decision: managed policy, authentication, onboarding/trust prompts,
or other startup failures can still interrupt a harness after preflight.
The probes make no model request and do not write harness settings.
