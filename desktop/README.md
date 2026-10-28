# Muxterm for macOS

This Wails app bundles the full muxterm server and opens it locally in a Mac
window. It starts its own loopback listener when the app launches, with config,
terminal sessions, and durable data in `~/Library/Application Support/muxterm-desktop/local`.
The native title bar shares muxterm's colors, including when the theme changes.
Remote muxterm URLs and SSH port forwarding remain available in **Connection
and ports…**; they are optional. The app does not install a system service.

The download contains no Node.js, npm, Python interpreter, or coding agent SDK
packages. Terminal workspaces and the browser work without them. Codex, Claude,
and ACP chats require Node.js 22 and npm installed on the Mac. Install Codex or
Claude Code separately and sign in; New Chat shows setup commands and uses the
installed CLI version. On the first such chat, muxterm downloads only the locked
SDK support libraries into its versioned user cache. Finder launches search
Homebrew, mise, asdf, Volta, and common user tool locations for the commands.
Amplifier uses an existing Python environment.

## Native browser and links

The **Browser** item in the Mac sidebar opens a native WebKit browser. External
links from Chats and terminals open there by default. **Settings → Appearance →
Links** can send them to the default browser instead. Browser tabs stay open
when switching between the Browser and Chats.

Coding agents launched by the bundled server receive a `mac_browser` MCP tool.
It can list and open tabs, navigate, inspect page text and interactive elements,
click, type, scroll, and capture a screenshot. The tool controls the same native
tabs visible in the Mac app. It is available only while that app is running.

## Remote Chats over SSH

Add an SSH host in **Settings → Remotes** and connect it. The Mac sidebar then
shows that host under **Remote sessions**, with its Chat folders and agent
sessions. Select a session to open the remote Muxterm UI in a separate Mac
window through an SSH loopback tunnel. The remote machine must run a version of
Muxterm that includes `desktop_remote_snapshot`, and `muxterm mcp` must be on
the remote login shell's `PATH`. SSH authentication uses your existing
`~/.ssh/config` and keys; no remote token is copied into the Mac app.

## CI build

The **Mac App** GitHub Actions workflow builds and ad hoc signs an Apple
Silicon `.app` on a Mac runner. Download the `muxterm-macos-arm64`
artifact from a successful run, unzip it, and open the app. The artifact is
ad hoc signed for development, not notarized for public distribution.

## Downloadable release

A `v*` tag builds a Developer ID signed, notarized, stapled Apple Silicon DMG
and an updater ZIP, then attaches both to the existing GitHub Release. The
signed app's **Settings → About → Update and restart** button downloads the ZIP,
checks its SHA-256 digest and Apple signature, replaces the installed app, and
reopens it. The app must be writable by the current user; a development or
ad hoc signed build cannot update itself. Existing installs need one manual
upgrade to a release containing this updater before that button appears. This
uses the same Apple ID
app-specific password method as SideHuddle; it does not publish to the Mac App
Store. Configure these repository Actions secrets before tagging:

- `MACOS_DEVELOPER_ID_P12_BASE64`: base64 encoded Developer ID Application `.p12`
- `MACOS_DEVELOPER_ID_P12_PASSWORD`: password used when exporting the `.p12`
- `APPLE_APP_PASSWORD`: Apple ID app-specific password for notarization

Set repository variable `APPLE_NOTARY_APPLE_ID` to the Apple ID that owns the
Developer team. The existing `APPLE_TEAM_ID` variable identifies that team.
To verify credentials before publishing a release, manually run **Mac App**
with `signed_preview` enabled. It uploads the notarized DMG as a workflow
artifact without creating a GitHub Release.

## Build on a Mac

Install Go 1.25 or later, Node 22, npm, and Xcode Command Line Tools. Then:

```sh
cd desktop
./build-mac.sh
open bin/Muxterm.app
```

For optional remote muxterm or dev server forwarding, set the SSH host to an
alias from `~/.ssh/config` or to `user@host`. Set the remote muxterm URL to its
HTTPS address, or to `http://localhost:<port>/` to forward its port over SSH.

The port forward stops when the app quits.
