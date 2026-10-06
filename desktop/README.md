# Muxterm for macOS

This Wails app displays the full muxterm web interface in a Mac window. The
native title bar shares muxterm's colors, including when the muxterm theme
changes. If the muxterm URL is a localhost port on an SSH host, the app
forwards that port to the same port on the Mac. The app does not install or
restart muxterm. Browser previews and other companion features are deferred.

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

Install Go 1.25 or later and Xcode Command Line Tools. Then:

```sh
cd desktop
./build-mac.sh
open bin/Muxterm.app
```

The Mac must have SSH key access to the machine running muxterm and your dev
servers. Set the SSH host to an alias from `~/.ssh/config` or to `user@host`.
Set the muxterm URL to its HTTPS address, or to `http://localhost:<port>/` to
forward its port over SSH.

The port forward stops when the app quits.
