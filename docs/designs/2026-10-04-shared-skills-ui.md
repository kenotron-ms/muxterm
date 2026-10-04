# Shared skills in chats

The Skills screen is a local UI over [Vercel's `skills` CLI](https://github.com/vercel-labs/skills). It lists global installs with `skills list --global --json` and installs a selected catalog entry with `skills add owner/repo@skill --global --agent codex --agent claude-code --yes`. The UI uses the [same skills.sh search API as the CLI's `find` command](https://github.com/vercel-labs/skills/blob/main/src/find.ts) because `find` has no machine-readable output. The package version is pinned in the server so an npm publish cannot silently change installer behavior.

The CLI's canonical global directory is `~/.agents/skills`. It links skills into Codex and Claude's global directories. Muxterm's Amplifier SDK chat mounts `tool-skills` with that same canonical directory added to the bundle's existing skill sources. See [Amplifier's skills module](https://github.com/microsoft/amplifier-module-tool-skills) for its source configuration and discovery behavior. New chats see newly installed skills; an already running harness may need a new session before its skill inventory refreshes.

The browser accepts catalog identifiers of the form `owner/repo/skill`; the server validates that shape and builds a fixed CLI argument list without a shell. The install route is protected by muxterm's normal browser authentication. Skills execute as part of a harness, so users can open catalog details before installing.

The pinned CLI requires Node.js 22.20 or newer. The server checks this before list/install and returns a readable prerequisite error if its Node runtime is older.

ACP harness support is being developed in a separate worktree. The shared directory can be reused there when its skill discovery contract is established.
