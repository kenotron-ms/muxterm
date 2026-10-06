# Muxterm for macOS

This Wails app runs the full muxterm web interface in a Mac window. Its Browser
button opens a right-side browser panel with tabs, navigation, and an address
bar. Preview pages run in native WKWebViews on the Mac. Selected ports from an
SSH host forward to the **same** ports on the Mac, so previews retain their
`localhost` origin and root path. The app does not install or restart muxterm.

## CI build

The **Mac App** GitHub Actions workflow builds and ad hoc signs an Apple
Silicon `.app` on a Mac runner. Download the `muxterm-macos-arm64`
artifact from a successful run, unzip it, and open the app. The artifact is
ad hoc signed for development, not notarized for public distribution.

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
forward its port over SSH. In the muxterm window, open **Browser** and enter a
preview URL such as `http://localhost:3000/`. Its port forwards automatically.

The port forwards stop when the app quits. Browser-based CLI login handoff
and automatic callback-port discovery are not yet wired; use
`az login --use-device-code` for Azure CLI login in the meantime.
