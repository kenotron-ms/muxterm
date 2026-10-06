# Muxterm for macOS

This Wails app bundles the full muxterm server and opens it locally in a Mac
window. It starts its own loopback listener when the app launches, with config,
terminal sessions, and durable data in `~/Library/Application Support/muxterm-desktop/local`.
The native title bar shares muxterm's colors, including when the theme changes.
Remote muxterm URLs and SSH port forwarding remain available in **Connection
and ports…**; they are optional. The app does not install a system service.

## CI build

The **Mac App** GitHub Actions workflow builds and ad hoc signs an Apple
Silicon `.app` on a Mac runner. Download the `muxterm-macos-arm64`
artifact from a successful run, unzip it, and open the app. The artifact is
ad hoc signed for development, not notarized for public distribution.

## Downloadable release

A `v*` tag builds a Developer ID signed, notarized, stapled Apple Silicon DMG
and attaches it to the existing GitHub Release. This uses the same Apple ID
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
