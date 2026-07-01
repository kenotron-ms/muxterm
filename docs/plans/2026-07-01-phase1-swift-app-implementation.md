# Phase 1 — muxterm Apple (Swift) Companion App Implementation Plan

> **For execution:** Use `/build-like-ken` mode.
> **New repository:** all paths below are relative to a brand-new repo, `muxterm-apple`, created **outside** the Go `muxterm` tree. This plan document lives in the Go repo (`docs/plans/`) for reference; the code it describes does not.

**Goal:** Ship a native Apple (macOS-first, then iOS/iPadOS) companion client that speaks muxterm's frozen WebSocket contract — terminal panes rendered from raw VT via `libghostty-vt`, a client-rendered/server-drivable browser pane, and embedded SSH so remote dev boxes feel local — all behind a unified, grouped-by-source dashboard that looks the same every launch.

**Architecture:** One Swift codebase, two run destinations (macOS AppKit host first; iOS/iPadOS second). Five bricks per the design doc: **Connection Manager** (SwiftNIO SSH), **Protocol Client** (`URLSessionWebSocketTask`), **Terminal Pane** (`libghostty-vt` parse + native cell-grid render), **Browser Pane** (`WKWebView` + `proxyConfigurations`), **Workspace/Layout UI** (SwiftUI chrome, AppKit for the perf-critical terminal/tiling surface). Local target connects straight to `localhost:<muxport>`; remote target opens one embedded SSH session carrying a single `-L` control forward plus a local SOCKS5 listener for the browser plane — so by the time `/ws` is opened it is **always** a loopback WebSocket and the "localhost = no token" auth dividend holds.

**Tech Stack:** Swift 5.10+ / Swift Package Manager; AppKit + a little SwiftUI (macOS), UIKit + SwiftUI (iOS); `URLSessionWebSocketTask` (WS); `swift-nio-ssh` (SSH client) + `swift-nio` (channels, SOCKS listener); `libghostty-vt` pinned/vendored via a SwiftPM system-library / binary target (C interop); `WKWebView` with `WKWebsiteDataStore.proxyConfigurations` (macOS 14+/iOS 17+); Metal or CoreText for cell-grid rendering. Minimum deployment: macOS 14, iOS 17 (required for `proxyConfigurations`).

**Verification approach:** Every milestone ends by running the real app against a **live local `muxterm serve`** and observing real behavior — never a mock. `xcodebuild` compiles each target; the settle-barrier and framing codec (pure logic bricks) get real unit tests with recorded fixture bytes; terminal, dashboard, browser, and SSH are verified by driving the running app (typing in a real shell, splitting real panes, and driving the browser pane through muxterm's MCP browser tools). A milestone is not "done" until the stated command has been run and the stated result observed.

---

## Reference: what the app must speak (read before M1)

These are the ground-truth artifacts in the Go repo. The Swift Protocol Client must match them byte-for-byte. Do not invent shapes — port these.

- **Message vocabulary + JSON tags:** `muxterm/web/src/types.ts` (`SessiondType`, `SessiondMessage`, `SessiondPaneInfo`). This TypeScript file mirrors the frozen Go `sessiond.Message` exactly and is the most readable spec.
- **Server bootstrap / relay:** `muxterm/internal/server/ws.go` — `attachClient()` sends `config` then `workspace-list` on connect; `handleTextInput()` shows every request→reply pair; `EncodeBinaryFrame`/`DecodeBinaryFrame` define `[4-byte LE paneId][payload]`.
- **The settle barrier to port faithfully:** `muxterm/web/src/lib/terminal-registry.ts` (the `PaneEntry` state machine, `_settleAndDrain`, `resetForReattach`, `setExpectedReplayBytes`, `write`) and its bootstrap caller `muxterm/web/src/app.ts` (~lines 505–540: on `composition`, for each pane `ensure()` → if reattach `resetForReattach()` → `setExpectedReplayBytes(pane.totalSeq)`).
- **The new browser messages (added in Phase 0):** `browser-command` (server→client `{paneId, cid, action, params}`), `browser-result` (client→server `{cid, result | error}`), `browser-url` / `browser-load` (client→server events). See `docs/designs/2026-06-30-native-companion-apps-design.md` §4. **If Phase 0 is not yet merged when M4 begins, read the frozen `muxterm-client-protocol.md` it produces for the exact `params` schema — do not guess field names.**

### Bootstrap sequence (the one flow the whole app hangs off)

```
client opens /ws  ──▶  server sends {type:"config", config:{…}}          (serve-local envelope, NOT a sessiond msg)
                  ──▶  server sends {type:"workspace-list", workspaces:[…]}
client sends {type:"attach", workspaceId, breakpoint, offsets?:[{paneId,seq}]}
                  ◀──  server sends {type:"composition", workspaceId, panes:[{paneId,cols,rows,totalSeq,seq,surfaceKind}], layout}
                  ◀──  binary replay frames [4-byte LE paneId][VT bytes]  (per pane, up to totalSeq-seq bytes)
                  ◀──  live binary frames continue after replay
```

`config` is a **serve envelope** (`{"type":"config","config":…}`), not part of the `sessiond` message enum — decode it specially. Everything else is a `sessiond.Message`.

---

## Milestone M1 — Project scaffold + Protocol Client

**Outcome:** A compiling macOS app that connects to a live local `muxterm serve`, runs the bootstrap, and logs a real `config` / `workspace-list` / `composition`. Framing + codec covered by unit tests with recorded fixture bytes.

### Repo / project layout (create these)

```
muxterm-apple/
├── Package.swift                       # SPM manifest: MuxtermKit lib + app targets
├── README.md
├── .gitignore                          # Xcode + SPM ignores
├── Sources/
│   └── MuxtermKit/                     # platform-agnostic core (the 5 bricks' shared logic)
│       ├── Protocol/
│       │   ├── SessiondMessage.swift   # Codable mirror of types.ts SessiondMessage
│       │   ├── SessiondType.swift      # string enum of message types
│       │   ├── PaneInfo.swift          # SessiondPaneInfo mirror (totalSeq, seq, surfaceKind…)
│       │   ├── BinaryFrame.swift       # encode/decode [4-byte LE paneId][payload]
│       │   ├── ConfigEnvelope.swift    # {type:"config", config:{…}} decoder
│       │   └── CIDGenerator.swift      # monotonic uint64 correlation ids
│       ├── ProtocolClient/
│       │   ├── ProtocolClient.swift    # URLSessionWebSocketTask wrapper, send/recv, demux
│       │   └── ProtocolClientDelegate.swift  # callbacks: onConfig/onWorkspaceList/onComposition/onPaneOutput/onEvent/onError
│       └── Log/
│           └── MuxLog.swift            # os.Logger wrapper, subsystem "app.muxterm"
├── Apps/
│   └── macOS/
│       ├── MuxtermMac.xcodeproj/       # or an SPM executable target — see note
│       ├── AppDelegate.swift
│       ├── ContentView.swift           # temporary: a log console for M1
│       └── Info.plist
├── Tests/
│   └── MuxtermKitTests/
│       ├── BinaryFrameTests.swift
│       ├── SessiondMessageTests.swift
│       ├── ConfigEnvelopeTests.swift
│       └── Fixtures/
│           └── bootstrap.jsonl         # recorded real frames (see task M1.6)
└── docs/
    └── muxterm-client-protocol.md      # COPY the frozen spec from the Go repo Phase 0 here
```

> **Project vs SPM note:** Prefer an `.xcodeproj` for the app targets (AppKit lifecycle, entitlements, code signing all live there), with `MuxtermKit` as a local SPM package the project depends on. If the junior engineer is more comfortable pure-SPM, an `executableTarget` works for M1–M2 but you'll need the `.xcodeproj` by M4 (WKWebView entitlements) and M6 (iOS target) anyway — create it now.

### Tasks

**M1.1 — SPM manifest + MuxtermKit skeleton.** Create `Package.swift` declaring a library `MuxtermKit` (platforms: `.macOS(.v14)`, `.iOS(.v17)`) and a test target. No external deps yet. Add the empty source folders above with a one-line doc comment per file.

**M1.2 — Message model (`SessiondType.swift`, `SessiondMessage.swift`, `PaneInfo.swift`).** Port `types.ts` exactly. `SessiondType` is a `String` raw enum (`attach`, `composition`, `workspace-list`, `create-pane`, `resize`, `pane-added`, `pane-closed`, `browser-command`, `browser-result`, `browser-url`, `browser-load`, …). `SessiondMessage` is `Codable` with **all optional** fields matching the JSON tags (`cid`, `workspaceId`, `paneId`, `cols`, `rows`, `cmd`, `panes`, `workspaces`, `layout`, `breakpoint`, `placement`, `referencePaneId`, `offsets`, `surfaceKind`, `error`, `code`). `cid` is `UInt64`. Use `CodingKeys` where Swift naming differs (it won't much — keep camelCase matching the wire).

**M1.3 — Binary frame codec (`BinaryFrame.swift`).** COMPLETE code below — this is a hard/exactness brick.

```swift
import Foundation

/// Wire framing for pane data: [4-byte LITTLE-ENDIAN uint32 paneId][raw bytes].
/// Byte-for-byte compatible with Go's server.EncodeBinaryFrame/DecodeBinaryFrame
/// and web/src/types.ts encodePaneFrame/decodePaneFrame.
enum BinaryFrame {
    /// Encode outbound pane input: keystrokes/paste as [paneId LE][bytes].
    static func encode(paneId: UInt32, data: Data) -> Data {
        var frame = Data(count: 4)
        frame.withUnsafeMutableBytes { raw in
            raw.storeBytes(of: paneId.littleEndian, as: UInt32.self)
        }
        frame.append(data)
        return frame
    }

    /// Decode an inbound pane-data frame. Returns nil if shorter than 4 bytes
    /// (matches Go returning an error for < 4).
    static func decode(_ frame: Data) -> (paneId: UInt32, data: Data)? {
        guard frame.count >= 4 else { return nil }
        // Copy the 4 header bytes out (frame may not be 4-byte aligned).
        let le = frame.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let paneId = UInt32(littleEndian: le)
        let payload = frame.subdata(in: frame.startIndex.advanced(by: 4)..<frame.endIndex)
        return (paneId, payload)
    }
}
```

> `loadUnaligned` requires the buffer to have ≥4 bytes — the guard ensures it. If targeting a Swift toolchain without `loadUnaligned`, assemble manually: `UInt32(frame[0]) | UInt32(frame[1])<<8 | UInt32(frame[2])<<16 | UInt32(frame[3])<<24` using `frame[frame.startIndex + i]`.

**M1.4 — CID generator + config envelope.** `CIDGenerator`: an actor (or `OSAllocatedUnfairLock`-guarded counter) handing out monotonically increasing `UInt64` starting at 1. `ConfigEnvelope.swift`: decode `{"type":"config","config": <opaque>}` — capture `config` as a `[String: AnyCodable]` or a raw `Data`/`JSONValue` blob (the app doesn't need to interpret every key in M1; it just logs it and later feeds font/theme to the terminal). Decode by first peeking `type`: if `type == "config"`, use this decoder; otherwise decode as `SessiondMessage`.

**M1.5 — ProtocolClient.** COMPLETE code below — this is the central brick. `URLSessionWebSocketTask` with a receive loop that demuxes text (JSON) vs binary (pane frames) and dispatches to a delegate. Include the bootstrap driver.

```swift
import Foundation

protocol ProtocolClientDelegate: AnyObject {
    func didReceiveConfig(_ config: Data)                       // raw {config:…} blob
    func didReceiveMessage(_ message: SessiondMessage)          // any sessiond text message
    func didReceivePaneOutput(paneId: UInt32, data: Data)       // binary frame
    func didClose(error: Error?)
}

/// Speaks muxterm's frozen /ws contract. Holds NO terminal state — it demuxes
/// frames and hands them to the delegate. One instance per connection.
final class ProtocolClient: NSObject {
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private let cids = CIDGenerator()
    weak var delegate: ProtocolClientDelegate?

    /// - Parameter url: e.g. ws://127.0.0.1:8311/ws  (always loopback: local
    ///   target directly, remote target via the -L forward's device port).
    init(url: URL) {
        self.url = url
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect() {
        let t = session.webSocketTask(with: url)
        self.task = t
        t.resume()
        receiveLoop()
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    // MARK: Outbound

    /// Send a sessiond text message. Assigns a fresh cid if the caller didn't set one.
    /// Returns the cid used so the caller can correlate the reply.
    @discardableResult
    func send(_ message: SessiondMessage) async throws -> UInt64 {
        var m = message
        let cid = m.cid ?? (await cids.next())
        m.cid = cid
        let data = try JSONEncoder().encode(m)
        try await task?.send(.data(data))   // text-as-data is fine; server json.Unmarshal doesn't care about frame opcode? -> use .string
        return cid
    }

    /// Send raw pane input as a binary frame.
    func sendPaneInput(paneId: UInt32, bytes: Data) async throws {
        try await task?.send(.data(BinaryFrame.encode(paneId: paneId, data: bytes)))
    }

    // MARK: Inbound

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.delegate?.didClose(error: err)
                return
            case .success(let message):
                switch message {
                case .data(let data):
                    self.handleInbound(data: data)
                case .string(let str):
                    self.handleInbound(data: Data(str.utf8))
                @unknown default:
                    break
                }
                self.receiveLoop()   // re-arm
            }
        }
    }

    /// A frame is EITHER a JSON text message OR a binary pane frame. muxterm
    /// sends pane output as WebSocket BINARY and JSON as TEXT, but URLSession
    /// collapses both into .data/.string non-deterministically for some servers,
    /// so we discriminate by content: a valid JSON object starting with '{' is
    /// a message; anything else is a binary pane frame.
    private func handleInbound(data: Data) {
        if data.first == UInt8(ascii: "{") {
            // Peek "type":"config" vs a sessiond message.
            if let cfg = ConfigEnvelope.decode(data) {
                delegate?.didReceiveConfig(cfg)
                return
            }
            if let msg = try? JSONDecoder().decode(SessiondMessage.self, from: data) {
                delegate?.didReceiveMessage(msg)
                return
            }
            MuxLog.protocol.error("undecodable text frame: \(data.count) bytes")
        } else {
            guard let (paneId, payload) = BinaryFrame.decode(data) else { return }
            delegate?.didReceivePaneOutput(paneId: paneId, data: payload)
        }
    }
}

extension ProtocolClient: URLSessionWebSocketDelegate {
    func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        MuxLog.protocol.info("ws open")
    }
    func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask,
                    didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        delegate?.didClose(error: nil)
    }
}
```

> **Two correctness notes for the implementer:** (1) muxterm sends JSON as WebSocket **text** and pane data as **binary**. Prefer sending our own text messages via `.string(String(data:encoding:))` so the server's frame-type expectations hold; the content-sniff on receive is a belt-and-suspenders fallback. (2) The `{`-sniff works because pane VT bytes effectively never begin with `0x7B` as the *first byte of a frame* in practice, but the frame-opcode is the real discriminator — if you can read the opcode from `URLSessionWebSocketTask.Message` (`.data` = binary, `.string` = text), trust that first and only sniff as fallback. Wire it opcode-first.

**M1.6 — Record real fixtures.** Run a live server, capture real frames, save to `Tests/MuxtermKitTests/Fixtures/`. Concretely:

```bash
# In the Go repo, build and run a real sessiond+serve on a known port:
cd /home/ken/workspace/muxterm && make build && ./bin/muxterm serve --port 8311 &
# Create a workspace with one pane so composition has real replay bytes:
#   (open http://localhost:8311 once in a browser, make a pane, type `ls`, then)
# Capture the bootstrap with a tiny websocat/wscat dump:
websocat -B 1048576 ws://127.0.0.1:8311/ws | head -c 20000 > /tmp/bootstrap.raw
```
Split the captured text frames into `bootstrap.jsonl` (one JSON per line: the `config`, the `workspace-list`, the `composition`) and save a couple of raw binary pane frames as `.bin` files. These are the golden bytes the codec tests assert against.

**M1.7 — Codec unit tests (real fixtures).** `BinaryFrameTests`: round-trip `encode`/`decode`, decode a real captured `.bin` frame and assert the paneId matches what the composition reported. `SessiondMessageTests`: decode each line of `bootstrap.jsonl`, assert `type`, and for the composition assert `panes[0].totalSeq` is present and > 0. `ConfigEnvelopeTests`: decode the captured config line, assert `type=="config"` recognized and the blob is non-empty. **These are pure-logic bricks → unit tests are the correct verification level here.**

**M1.8 — Minimal macOS host + bootstrap driver.** A bare AppKit window whose view model: creates `ProtocolClient(url: ws://127.0.0.1:8311/ws)`, implements the delegate to append every event to an on-screen log, and on `didReceiveMessage(workspace-list)` sends `attach` for the first workspace with `breakpoint:"desktop"`. Log the `composition` panes and each pane-output frame's `(paneId, byteCount)`.

### M1 Verification

```bash
# Static analysis / build:
cd muxterm-apple && xcodebuild -scheme MuxtermMac -destination 'platform=macOS' build
# Unit tests (pure-logic bricks):
swift test           # or: xcodebuild test -scheme MuxtermKit -destination 'platform=macOS'
```
Expected: build succeeds; all codec/message tests PASS.

```bash
# Live end-to-end: start a real server, run the app, watch the log.
cd /home/ken/workspace/muxterm && ./bin/muxterm serve --port 8311 &
# launch the built MuxtermMac app (open the .app or `xcodebuild ... -launch`)
```
Expected in the app's log console, in order: `config` received (non-empty blob) → `workspace-list` with ≥1 workspace → after auto-`attach`, a `composition` listing panes with `totalSeq` values → a burst of pane-output frames whose summed byte count for each pane ≈ that pane's `totalSeq`. **That byte-count match is the proof the framing + demux are correct against reality.**

**Commit** after each task (`feat(protocol): binary frame codec`, `test(protocol): codec fixtures`, `feat(app): m1 bootstrap driver`, …).

---

## Milestone M2 — Terminal Pane (the hard brick)

**Outcome:** Running the macOS app against a live sessiond, you attach a workspace, see a real shell render, type commands that execute, and the settle-barrier scenarios (exact `totalSeq`, overshoot, 3s timeout escape, reattach-mid-replay) behave correctly.

### Files

```
Sources/MuxtermKit/
├── Ghostty/
│   ├── GhosttyVT.swift            # thin Swift wrapper over libghostty-vt C API
│   ├── CGhosttyVT/                # SPM system-library or binary target for the C headers
│   │   ├── module.modulemap
│   │   └── shim.h
│   └── VENDORING.md               # pinned commit, build steps (see M2.1)
├── Terminal/
│   ├── PaneState.swift            # the ported settle-barrier state machine
│   ├── PaneRegistry.swift         # per-pane owner (mirror of terminal-registry.ts)
│   └── Keymap.swift               # keystroke → VT byte encoder (ours to own)
Apps/macOS/
├── TerminalView.swift             # NSView subclass: cell-grid renderer (Metal or CoreText)
└── TerminalViewController.swift   # wires PaneRegistry ↔ TerminalView ↔ ProtocolClient
Tests/MuxtermKitTests/
├── PaneStateTests.swift           # settle-barrier scenarios (pure logic — unit tested)
└── KeymapTests.swift              # modifier/arrow/fn encodings
```

### Tasks

**M2.1 — Vendor & pin libghostty-vt.** This needs the design doc's caution honored, not invented specifics. Steps: (a) pick a specific libghostty-vt commit (the design flags its API as pre-1.0/churning — **pin one commit hash, record it in `VENDORING.md`**); (b) build it as a static lib (`libghostty-vt.a`) with a Zig toolchain, or consume a prebuilt xcframework if one exists at the pin; (c) expose a `CGhosttyVT` SPM target with a `module.modulemap` pointing at the C header. **Honesty flag:** the exact C symbol names (`ghostty_vt_new`, feed, cursor/cell accessors) depend on the pinned commit's header — the junior engineer must read the vendored header and map real symbols; do not fabricate a symbol list here. `VENDORING.md` must capture: the commit, the build command, and the header path.

**M2.2 — GhosttyVT Swift wrapper.** Wrap the C API behind a *stable* interface so the churn is isolated (design doc mitigation). Target surface:

```swift
/// Stable Swift face over the pinned libghostty-vt C core. The ONLY file that
/// touches C symbols directly — everything else uses this. Isolating churn here
/// is the design's explicit mitigation for libghostty-vt's pre-1.0 API.
final class GhosttyVT {
    private let handle: OpaquePointer   // ghostty_vt_t* (real type per pinned header)

    init(cols: Int, rows: Int, scrollback: Int) {
        // handle = ghostty_vt_new(...)  ← real signature from vendored header
        fatalError("map to real ghostty_vt_new from the pinned header")
    }
    deinit { /* ghostty_vt_free(handle) */ }

    /// Feed raw VT bytes (replay or live). Parser updates the screen/scrollback.
    func feed(_ bytes: Data) { /* ghostty_vt_feed(handle, ptr, len) */ }

    /// Resize the emulator grid. Idempotent at call site.
    func resize(cols: Int, rows: Int) { /* ghostty_vt_resize(...) */ }

    /// Snapshot the current grid for the renderer: rows of cells (glyph + fg/bg + attrs).
    func snapshotGrid() -> CellGrid { /* read cells via accessors */ CellGrid.empty }
}

struct Cell { var scalar: Unicode.Scalar; var fg: UInt32; var bg: UInt32; var attrs: UInt16 }
struct CellGrid { var cols: Int; var rows: Int; var cells: [Cell]; static let empty = CellGrid(cols:0,rows:0,cells:[]) }
```

Wrap every C call so a libghostty-vt fault degrades the one pane (design Error-Handling §): if a call traps, mark the pane errored and offer reattach — never crash the app.

**M2.3 — PaneState: PORT the settle barrier faithfully.** This is a direct port of `web/src/lib/terminal-registry.ts`'s `PaneEntry` + `_settleAndDrain` + `write` + `resetForReattach` + `setExpectedReplayBytes`. Keep the RC-labelled behavior. COMPLETE code below — this is the highest-risk logic brick and the design says "port the behavior rather than rediscover the races."

```swift
import Foundation

/// Faithful port of the web client's per-pane settle-barrier state machine
/// (web/src/lib/terminal-registry.ts). The RC-* labels are scar tissue from
/// real race fixes — preserve the behavior exactly.
///
/// Threading: drive ALL methods on one serial queue (or @MainActor). The web
/// original is single-threaded (JS event loop); replicate that discipline.
final class PaneState {
    let paneId: UInt32
    let vt: GhosttyVT

    /// Gates BOTH user input (keystrokes suppressed) and the drain to the
    /// renderer until replay has fully arrived. Mirrors entry.ready.
    private(set) var ready = false
    /// composition.pane.totalSeq minus seq — exact replay byte count to wait for.
    private var expectedReplayBytes = 0
    /// Bytes received since the last attach cycle (replay + live). Mirrors seqBytes.
    private var seqBytes = 0
    /// Data buffered before ready. Mirrors pendingData.
    private var pendingData: [Data] = []
    /// Guards against concurrent drains (RC-2).
    private var draining = false
    /// Cancels in-flight/stale drains after reset/close (RC-3/5/6).
    private var generation = 0
    /// performance.now()-equivalent start of the RC-1 wait; 0 = not started.
    private var settleWaitStart: TimeInterval = 0

    /// Sends encoded VT input upstream (wired to ProtocolClient.sendPaneInput).
    var onInput: ((Data) -> Void)?
    /// Requests a re-render of the grid (renderer reads vt.snapshotGrid()).
    var onRender: (() -> Void)?

    init(paneId: UInt32, vt: GhosttyVT) { self.paneId = paneId; self.vt = vt }

    /// Called from the composition handler BEFORE any replay frames. Mirrors
    /// setExpectedReplayBytes — do NOT reset seqBytes (frames may have raced ahead).
    func setExpectedReplayBytes(_ n: Int) {
        expectedReplayBytes = n
        MuxLog.terminal.debug("pane \(self.paneId) expect=\(n) seqBytes=\(self.seqBytes)")
    }

    /// Called on reconnect BEFORE new replay. Mirrors resetForReattach: resets
    /// ONLY settle state, preserves the emulator+scrollback, bumps generation.
    func resetForReattach() {
        ready = false
        draining = false
        pendingData = []
        generation += 1          // cancel in-flight drains
        seqBytes = 0
        expectedReplayBytes = 0
        settleWaitStart = 0
    }

    /// Every inbound pane frame (replay + live). Mirrors registry.write().
    func write(_ data: Data) {
        seqBytes += data.count
        if ready {
            vt.feed(data)
            onRender?()
        } else {
            pendingData.append(data)
            // RC-7: once all replay bytes are in, kick the drain.
            if !draining && expectedReplayBytes > 0 && seqBytes >= expectedReplayBytes {
                settleAndDrain()
            }
        }
    }

    /// Mirrors _settleAndDrain. Call on attach and whenever new data may complete
    /// replay. Assumes the view is at a plausible size already (caller checks).
    func settleAndDrain() {
        if ready || draining { return }               // RC-2

        // RC-1 barrier: wait until all expected replay bytes arrived, with a
        // hard 3s escape so a byte-count mismatch can't lock the pane forever.
        if seqBytes < expectedReplayBytes {
            let now = Date().timeIntervalSince1970
            if settleWaitStart == 0 { settleWaitStart = now }
            let waited = now - settleWaitStart
            if waited < 3.0 {
                // Reschedule shortly; the next frame's write() will also retry.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, gen = generation] in
                    guard let self, self.generation == gen else { return }
                    self.settleAndDrain()
                }
                return
            }
            MuxLog.terminal.warning("pane \(self.paneId) RC-1 TIMEOUT — draining partial replay")
        }

        let pending = pendingData; pendingData = []
        if pending.isEmpty {
            ready = true                              // fresh/pre-buffered pane
            onRender?()
            return
        }

        draining = true
        let myGen = generation
        for chunk in pending { vt.feed(chunk) }
        // vt.feed is synchronous (unlike xterm's async write callback), so the
        // drain completes here. Guard against a reset that landed mid-loop.
        if generation != myGen { return }             // RC-3/6
        ready = true
        draining = false
        onRender?()
        // Any live data that arrived during the (synchronous) drain is already
        // in pendingData via write(); flush it.
        let live = pendingData; pendingData = []
        for chunk in live { vt.feed(chunk) }
        if !live.isEmpty { onRender?() }
    }

    /// A keystroke, already encoded to VT bytes by Keymap. Suppressed until ready
    /// (mirrors the onData ready-gate that prevents replayed capability-query
    /// responses from leaking upstream).
    func sendInput(_ vtBytes: Data) {
        guard ready else {
            MuxLog.terminal.debug("pane \(self.paneId) input SUPPRESSED (not ready)")
            return
        }
        onInput?(vtBytes)
    }
}
```

> **Key porting difference to call out to the implementer:** xterm.js's `term.write(chunk, callback)` is **asynchronous** (the ready flip happens in the write callback), which is why the web code has the `onWriteDone`/`remaining` dance and the `generation` check inside the callback. `libghostty-vt.feed()` is **synchronous**, so the drain simplifies as shown — but keep the `generation` guard and the pending/live split so a `resetForReattach()` racing an in-progress drain still behaves. If your libghostty-vt binding turns out to feed asynchronously, restore the callback-counting structure from the web original verbatim.

**M2.4 — PaneRegistry.** Mirror `terminal-registry.ts`'s module singleton: a `[compositeKey: PaneState]` map keyed `"\(workspaceId):\(paneId)"` (prevents cross-workspace scrollback bleed), `ensure(paneId:)`, `write(paneId:data:)`, `prune(liveIds:)`, `setWorkspace(_:)`. On `composition`: for each pane, `ensure` → if it already existed call `resetForReattach()` → `setExpectedReplayBytes(totalSeq - seq)`. This is the exact ordering from `app.ts` ~505–540.

**M2.5 — Keymap (ours to own).** libghostty-vt does **not** encode input. Build the keystroke→VT byte encoder: printable chars → UTF-8; `Return`→`\r`; `Backspace`→`0x7f`; arrows→`ESC[A/B/C/D` (and `ESC OA…` in app-cursor mode if you track it — start with normal mode); `Esc`→`0x1b`; `Tab`→`\t`; Ctrl-letter → `byte & 0x1f`; function keys → standard `ESC[…~` / `ESC O…` sequences; handle macOS modifier flags (`⌥` as Meta→ESC-prefix when configured). IME/marked-text: on macOS, adopt `NSTextInputClient` on `TerminalView` so composed characters commit as UTF-8 through the same path. Unit-test the pure encodings.

**M2.6 — TerminalView cell-grid renderer.** An `NSView` (macOS) that on `onRender` reads `vt.snapshotGrid()` and draws the cell grid. Start with **CoreText** (simpler: measure a monospace cell, draw each row's attributed string with fg/bg) to get correctness fast; note Metal as a later perf pass (Deferred). Measure cell size for the current font → derive cols/rows from the view's pixel box (design §3 sizing: "measure cell size, divide the pane's pixel box" — client sizes independently). On size change, call `vt.resize(cols,rows)` and send a `resize` JSON message (idempotent — skip if unchanged), and only when the size is *plausible* (port the `_MIN_FIT_WIDTH/HEIGHT` 120×60 floor to avoid pushing transient tiny sizes to the PTY).

**M2.7 — TerminalViewController glue.** Own a `PaneRegistry`, wire `PaneState.onInput → protocolClient.sendPaneInput`, `onRender → TerminalView.setNeedsDisplay`. Route `ProtocolClientDelegate.didReceivePaneOutput → registry.write`, and `didReceiveMessage(composition) → registry` composition apply. Handle keyDown on the focused pane → `Keymap.encode → PaneState.sendInput`.

**M2.8 — PaneStateTests (real logic, unit-tested).** Port the web `RC-*` scenarios: (a) exact `totalSeq` — feed exactly `expectedReplayBytes`, assert `ready` flips and `onInput` now passes through; (b) overshoot — feed more than expected, assert no crash and ready; (c) 3s timeout escape — set `expectedReplayBytes` high, feed less, advance time, assert ready after the escape (inject a clock or make the delay parameter injectable for the test); (d) reattach mid-replay — begin a drain, call `resetForReattach()`, assert the stale generation's continuation is dropped and a fresh replay drains cleanly. **Pure state-machine logic → unit tests are correct here.** Keep `KeymapTests` for the encodings.

### M2 Verification

```bash
xcodebuild -scheme MuxtermMac -destination 'platform=macOS' build
swift test    # PaneStateTests + KeymapTests PASS
```

```bash
# Live: real shell in a real pane.
cd /home/ken/workspace/muxterm && ./bin/muxterm serve --port 8311 &
# launch MuxtermMac, attach the workspace
```
Expected, observed by hand in the running app:
1. The pane renders the shell prompt (real cell-grid output, correct colors).
2. Type `echo hello` + Return → `hello` prints. Type `ls` → directory listing renders.
3. Kill and restart nothing — instead force a reconnect (stop/start `serve`, or add a "reconnect" debug button): the pane re-attaches, scrollback is preserved, fresh replay drains, input works again (reattach path).
4. Watch the log: for the initial attach, `ready` flips only after `seqBytes >= expectedReplayBytes` (or the 3s escape logs `RC-1 TIMEOUT`). Keystrokes typed before ready are logged `SUPPRESSED`.

---

## Milestone M3 — Dashboard + Workspace UI

**Outcome:** Launch the macOS app cold with **no** sessiond running → the app auto-starts a local sessiond → the `Local` group auto-populates → you open a workspace, split panes, and the tiled layout persists per breakpoint.

### Files

```
Sources/MuxtermKit/
├── Model/
│   ├── AppState.swift            # {connections[], groups[], activeWorkspace, …} — the ObservableObject
│   ├── Connection.swift          # {name, target: .local | .remote(host,port,identity), rememberedWorkspaces}
│   └── LayoutBlob.swift          # native tiling encoding, round-tripped through `layout`, keyed by breakpoint
├── Local/
│   └── LocalSessiondLauncher.swift  # find-or-spawn a local `muxterm serve`
Apps/macOS/
├── DashboardView.swift           # SwiftUI: grouped-by-source list (Local + remotes)
├── WorkspaceWindow.swift         # AppKit window hosting the tiled TerminalViews
├── TilingContainerView.swift     # split/resize container (NSSplitView-based)
└── Sidebar.swift                 # grouped connections + workspaces (desktop nav)
```

### Tasks

**M3.1 — Connection + AppState model.** `Connection` per the design ("a saved list of `{name, target, remembered forwards}`"; forwards are the two fixed system-managed channels, **not** a user-editable list). `AppState` is the single `ObservableObject` the UI binds to — shape `{workspaces[], panes[], activePaneId, layout}` matching the web `MuxStore`. Groups are computed: one `Local` group (desktop only) + one per remote connection.

**M3.2 — LocalSessiondLauncher (desktop auto-start).** The dashboard's anti-headache behavior: on macOS launch, if no local sessiond is reachable, spawn one. Concretely: probe `127.0.0.1:<defaultPort>` (or the muxterm control socket); if absent, `Process`-launch the bundled/`PATH` `muxterm serve` and wait for the port to accept. Surface failures as a typed error in the `Local` group header, never a silent empty group. (Design: "Desktop auto-starts a local sessiond … the app never opens cold/empty.")

> **Honesty flag:** how muxterm exposes "is a local daemon already running" (a pidfile, a unix socket path, a fixed port) must be read from the Go repo — check `internal/service/` and `cmd/muxterm/` for the serve port/socket convention before wiring the probe. Do not assume a port.

**M3.3 — DashboardView (unified, grouped-by-source).** SwiftUI list rendering, in stable order every launch: `Local` group (desktop) with its workspace cards + `+ new`, then each remote group (always listed for stable layout; lazy-connect on expand, showing remembered last-known workspaces before SSH completes). Mirror the tablet/desktop wireframes in the UX doc §1. `+ Add` opens the Add-Connection sheet (built in M5).

**M3.4 — WorkspaceWindow + TilingContainerView.** Opening a workspace card attaches it (M1 bootstrap) and shows the tiled canvas. Use `NSSplitView` (nested) for the dockview-equivalent tiling: focused pane highlight border, per-pane slim title bar (name, close, maximize), drag edge to resize, `⌘\` split, `⌘T` new terminal, `⌘1..9` jump. Each leaf hosts a `TerminalView` from M2. New pane = `create-pane` message; placement `split-right`/etc.

**M3.5 — LayoutBlob persistence (per breakpoint).** Layout is **opaque to the server** (design §2). Define a native JSON encoding of the split tree, serialize it into the `layout` field of `save-layout` keyed by `breakpoint:"desktop"`, and restore it from the `composition.layout` on attach. Accept per-client layout (a web-created pane won't auto-place — append it). On iOS later this reuses the same field with `breakpoint:"phone"` (M6).

**M3.6 — Sidebar.** Desktop persistent left sidebar: grouped connections + workspaces, `+ Add`, `⚙ Settings`. All three hierarchy levels visible at once (desktop pole).

### M3 Verification

```bash
xcodebuild -scheme MuxtermMac -destination 'platform=macOS' build
```

```bash
# Ensure NO muxterm serve is running first:
pkill -f 'muxterm serve' || true
# Launch MuxtermMac cold.
```
Expected, observed by hand:
1. App opens to the dashboard with a populated `Local` group **without** you having started a server — the launcher auto-started one (verify with `pgrep -f 'muxterm serve'` → a PID exists that the app spawned).
2. `Local` shows real workspaces (or an empty-but-valid `+ new` affordance if none exist); remote connections appear listed but collapsed.
3. Open a workspace → tiled canvas renders the M2 terminal. `⌘\` splits → a second real shell appears in a split. Resize the divider → both panes reflow (cols/rows update, `resize` sent).
4. Quit and relaunch → the split layout is restored (LayoutBlob round-trip through `layout`).

---

## Milestone M4 — Browser Pane + server-drive

**Outcome:** A `WKWebView` browser pane renders a page; driving it through **muxterm's MCP browser tools** (against the running app) performs real navigation, clicks, scrolls, and JS-eval that round-trip back as `browser-result`/`browser-url`/`browser-load`. The "agent driving" authority banner reflects control.

> **Depends on Phase 0** being merged (the `browser-command`/`browser-result`/`browser-url`/`browser-load` messages + the MCP relay). If Phase 0 isn't merged, M4 can build the executor and verify locally with a synthetic `browser-command` injected in a debug harness, but the **MCP-drive** verification requires Phase 0 live. Read the frozen `muxterm-client-protocol.md` for the exact `params` schema.

### Files

```
Sources/MuxtermKit/Browser/
├── BrowserCommand.swift          # Codable {paneId, cid, action, params(selector? | x/y? | url? | script?)}
├── BrowserExecutor.swift         # maps a command → native nav OR evaluateJavaScript
└── BrowserAuthority.swift        # last-focus-wins {you | agent} state
Apps/macOS/
├── BrowserPaneView.swift         # WKWebView + chrome (‹ › ⟳, URL field, ⚡ port chip, authority banner)
└── BrowserPaneController.swift   # wires executor ↔ WKWebView ↔ ProtocolClient
```

### Tasks

**M4.1 — BrowserCommand model.** Port the Phase 0 `browser-command` `params` schema exactly. An action carries **exactly one** of `{selector}` or `{x,y}` (design §4 decision). Actions: `navigate`/`back`/`forward`/`reload` (native), `click`/`mousedown`/`mouseup`/`scroll`/`drag`/`touch` (injected JS), `inject` (evaluateJavaScript, result returned). Include the bounded JS timeout (default 30s, configurable) field.

**M4.2 — BrowserExecutor (the JS-injection brick).** COMPLETE code below — this is the hard/risky brick. Every manipulation compiles to a native call or evaluated JavaScript. Both targeting modes (selector and x/y) MUST be implemented.

```swift
import WebKit

/// Executes a browser-command against a live WKWebView. Every manipulation is
/// EITHER a native navigation call OR evaluated JavaScript — the same mechanism
/// playwright/agent-browser use. Selector AND coordinate targeting both required
/// (design §4). Returns a Codable result or a typed error for browser-result.
@MainActor
final class BrowserExecutor {
    private let webView: WKWebView
    private let jsTimeout: TimeInterval

    init(webView: WKWebView, jsTimeout: TimeInterval = 30) {
        self.webView = webView
        self.jsTimeout = jsTimeout
    }

    func execute(_ cmd: BrowserCommand) async -> BrowserResult {
        switch cmd.action {
        case .navigate:
            guard let urlStr = cmd.params.url, let url = URL(string: urlStr) else {
                return .error(code: "bad-params", message: "navigate requires params.url")
            }
            webView.load(URLRequest(url: url))
            return .ok(nil)
        case .back:    webView.goBack();    return .ok(nil)
        case .forward: webView.goForward(); return .ok(nil)
        case .reload:  webView.reload();    return .ok(nil)

        case .click, .mousedown, .mouseup, .scroll, .drag, .touch:
            let js = Self.buildEventJS(cmd)
            return await evalJS(js)

        case .inject:
            guard let script = cmd.params.script else {
                return .error(code: "bad-params", message: "inject requires params.script")
            }
            return await evalJS(script)
        }
    }

    /// Build the JS that dispatches a synthetic event, targeting EITHER an element
    /// (selector) OR coordinates (x,y). Exactly one is present per the contract.
    private static func buildEventJS(_ cmd: BrowserCommand) -> String {
        let p = cmd.params
        // Resolve the target element expression.
        let targetExpr: String
        if let sel = p.selector {
            targetExpr = "document.querySelector(\(sel.asJSStringLiteral))"
        } else if let x = p.x, let y = p.y {
            targetExpr = "document.elementFromPoint(\(x), \(y))"
        } else {
            return "throw new Error('command requires selector or x,y')"
        }
        let x = p.x.map(String.init) ?? "0"
        let y = p.y.map(String.init) ?? "0"

        switch cmd.action {
        case .click:
            return """
            (function(){ const el = \(targetExpr); if(!el) throw new Error('no target');
              const o={bubbles:true,cancelable:true,clientX:\(x),clientY:\(y),view:window};
              el.dispatchEvent(new PointerEvent('pointerdown',o));
              el.dispatchEvent(new MouseEvent('mousedown',o));
              el.dispatchEvent(new PointerEvent('pointerup',o));
              el.dispatchEvent(new MouseEvent('mouseup',o));
              el.dispatchEvent(new MouseEvent('click',o));
              return true; })()
            """
        case .scroll:
            let dx = p.deltaX.map(String.init) ?? "0"
            let dy = p.deltaY.map(String.init) ?? "0"
            return "(function(){ const el=\(targetExpr)||window; el.scrollBy(\(dx),\(dy)); return true; })()"
        case .mousedown, .mouseup:
            let type = cmd.action == .mousedown ? "mousedown" : "mouseup"
            return "(function(){const el=\(targetExpr);if(!el)throw new Error('no target');el.dispatchEvent(new MouseEvent('\(type)',{bubbles:true,cancelable:true,clientX:\(x),clientY:\(y)}));return true;})()"
        case .drag, .touch:
            // Synthetic Touch/drag sequence — see design §4; expand per params.
            return "(function(){const el=\(targetExpr);if(!el)throw new Error('no target');/* dispatch touch/drag sequence */ return true;})()"
        default:
            return "throw new Error('unhandled action')"
        }
    }

    private func evalJS(_ js: String) async -> BrowserResult {
        // Bounded timeout so an agent's script can never hang the pane/tool.
        let work = Task { () -> BrowserResult in
            do {
                let value = try await webView.evaluateJavaScript(js)
                return .ok(JSONValue(fromAny: value))
            } catch {
                return .error(code: "js-exception", message: "\(error)")
            }
        }
        let timeout = Task { () -> BrowserResult in
            try? await Task.sleep(nanoseconds: UInt64(jsTimeout * 1_000_000_000))
            work.cancel()
            return .error(code: "js-timeout", message: "evaluateJavaScript exceeded \(jsTimeout)s")
        }
        let result = await work.value
        timeout.cancel()
        return result
    }
}

extension String {
    /// JSON-encode this string so it embeds safely as a JS string literal.
    var asJSStringLiteral: String {
        (try? String(data: JSONEncoder().encode(self), encoding: .utf8)) ?? "\"\""
    }
}
```

**M4.3 — BrowserPaneController wiring.** Route `ProtocolClientDelegate.didReceiveMessage(browser-command)` → `BrowserExecutor.execute` → send `browser-result {cid, result|error}`. Observe `WKNavigationDelegate`: on committed navigation send `browser-url`; on `didFinish` send `browser-load` (the two events are distinct per design §4). Enforce authority: a command to an unfocused/unattached pane returns typed `no-client-attached` / `not-authority` (fail loud, no queuing).

**M4.4 — BrowserPaneView chrome + authority banner.** `‹ › ⟳`, URL field, `⚡ port chip` (populate from muxterm's listening-port tracking — surface live ports as tappable suggestions; manual entry always available), and the slim authority banner: `◉ agent driving` while an MCP command stream is active, `● you` when the human holds focus. Last-focus-wins: tapping the page flips to `● you`; the next agent command flips to `◉ agent` (design §4 / UX §4).

**M4.5 — SOCKS routing hook (stub until M5).** For **local** target the webview needs no proxy. Leave a clean seam (`BrowserPaneController.configureProxy(_:)`) that M5 fills with `WKWebsiteDataStore.proxyConfigurations` pointing at the local SOCKS5 listener. In M4 verify against a **local** dev server so no proxy is needed.

### M4 Verification

```bash
xcodebuild -scheme MuxtermMac -destination 'platform=macOS' build
```

Live MCP-drive (requires Phase 0 merged + a running app with a browser pane):
```bash
# 1. Run a real dev server to point the pane at:
python3 -m http.server 5173 &     # serves cwd at http://localhost:5173
# 2. Run muxterm serve (with Phase 0 browser relay) and launch MuxtermMac.
cd /home/ken/workspace/muxterm && ./bin/muxterm serve --port 8311 &
# 3. In the app: create a browser pane, navigate it to http://localhost:5173
# 4. Drive it from an MCP client using muxterm's browser tools:
```
Using the `muxterm` MCP browser tools against the running app, expected observed behavior:
1. A `navigate` tool call changes the pane's URL → the page loads → app emits `browser-url` then `browser-load` (visible in the app log and returned to the tool).
2. A `click` with a `selector` dispatches on the real element (e.g. a link) → the page reacts.
3. A `click` with `x,y` hits `elementFromPoint` at those coords → the page reacts.
4. An `inject` (evaluateJavaScript, e.g. `document.title`) returns the real value in `browser-result`.
5. The authority banner shows `◉ agent driving` during the tool stream; tapping the page flips it to `● you`.
6. A command to a non-focused browser pane returns a typed `not-authority` error (fail loud).

---

## Milestone M5 — Remote connectivity (SSH + SOCKS)

**Outcome:** Connect to a **real remote box** (or a second local sshd) via the Add-Connection flow; the terminal works over the single `-L` control forward (loopback auth dividend holds) and the browser pane reaches the remote's `localhost:PORT` over the SOCKS-over-SSH channel — both on one embedded SSH session.

### Files

```
Sources/MuxtermKit/Connectivity/
├── SSHSession.swift              # swift-nio-ssh client: dial, auth, one session
├── ControlForward.swift          # the single -L forward (remote muxport → device loopback)
├── SocksListener.swift           # local SOCKS5 listener → SSH direct-tcpip channels
├── Identity.swift                # SSH key management (agent/~/.ssh on desktop; keychain on mobile)
└── ConnectProgress.swift         # typed step/failure model for the progress trail
Apps/macOS/
├── AddConnectionSheet.swift      # name / target / host / identity
└── ConnectTrailView.swift        # Reaching → SSH auth → Forwarding → Attaching → ✓
```

### Tasks

**M5.1 — SSHSession (swift-nio-ssh client).** Add `swift-nio` + `swift-nio-ssh` SPM deps. Dial `host:port`, authenticate with a key (desktop: try the system SSH agent / `~/.ssh` keys; explicit "key rejected (tried id_ed25519)" on failure — **no** fallback to the legacy HMAC token, design Error-Handling §). One `NIOSSHHandler` session carries both channels.

> **Honesty flag:** swift-nio-ssh is a low-level library — the junior engineer must implement `NIOSSHClientUserAuthenticationDelegate` (key/agent auth) and `NIOSSHClientServerAuthenticationDelegate` (host-key trust-on-first-use + a known-hosts store). These delegate conformances are non-trivial and library-version-specific; follow swift-nio-ssh's current example client rather than any invented API here. Record the pinned swift-nio-ssh version.

**M5.2 — ControlForward (the auth dividend).** Open one SSH `-L`-style local forward: bind a device loopback port, forward to the remote's muxterm control port via a `direct-tcpip` channel. The Protocol Client then opens `ws://127.0.0.1:<devicePort>/ws` — **loopback**, so the server applies "localhost = no token." Design §1-revised: one known port, dead simple. Discover the remote muxport (a fixed default, or read it after starting `muxterm serve` on the remote — check the Go repo's serve port convention).

**M5.3 — SocksListener (browser plane).** COMPLETE the SOCKS5 handshake skeleton (the cmux pattern): a tiny local `NIOSSHClient`-fronted SOCKS5 server. On each SOCKS `CONNECT` to `localhost:PORT`, open an SSH `direct-tcpip` channel to the **remote's** `localhost:PORT` and pump bytes both ways. This is the plumbing that makes `http://localhost:3000` in the browser pane hit the dev box.

```swift
// SOCKS5 CONNECT handshake (RFC 1928) — the parse/reply half. The channel-open
// half (map CONNECT → SSH direct-tcpip) is wired to SSHSession.openDirectTCPIP.
// This is skeleton-complete for the handshake; the byte-pump uses NIO channel
// glue per swift-nio-ssh's port-forwarding example.
enum Socks5 {
    // Greeting: [0x05][nMethods][methods…] → reply [0x05][0x00] (no auth).
    static func parseGreeting(_ bytes: [UInt8]) -> Bool {
        bytes.count >= 2 && bytes[0] == 0x05
    }
    static let greetingReply: [UInt8] = [0x05, 0x00]

    // Request: [0x05][0x01 CONNECT][0x00][ATYP][addr][port hi][port lo].
    struct Request { var host: String; var port: UInt16 }
    static func parseConnect(_ b: [UInt8]) -> Request? {
        guard b.count >= 7, b[0] == 0x05, b[1] == 0x01 else { return nil }
        let atyp = b[3]
        switch atyp {
        case 0x01: // IPv4
            guard b.count >= 10 else { return nil }
            let host = "\(b[4]).\(b[5]).\(b[6]).\(b[7])"
            let port = UInt16(b[8]) << 8 | UInt16(b[9])
            return Request(host: host, port: port)
        case 0x03: // domain
            let len = Int(b[4]); guard b.count >= 5 + len + 2 else { return nil }
            let host = String(bytes: b[5..<5+len], encoding: .utf8) ?? ""
            let port = UInt16(b[5+len]) << 8 | UInt16(b[6+len])
            return Request(host: host, port: port)
        default: return nil // IPv6 (0x04) — add if needed
        }
    }
    // Success reply: [0x05][0x00][0x00][0x01][0,0,0,0][0,0].
    static let connectSuccess: [UInt8] = [0x05,0x00,0x00,0x01,0,0,0,0,0,0]
    static let connectFail:    [UInt8] = [0x05,0x01,0x00,0x01,0,0,0,0,0,0]
}
```

**M5.4 — Wire proxy into the browser pane.** Fill the M4.5 seam: set `webView.configuration.websiteDataStore.proxyConfigurations = [.init(socksv5Proxy: .init(host: "127.0.0.1", port: socksPort))]` (macOS 14+/iOS 17+, scoped to that webview's data store). Now `localhost:PORT` in the pane resolves to the dev box. Local target skips this entirely.

**M5.5 — Identity management.** Desktop: enumerate agent/`~/.ssh` keys. `Identity.swift` selects and reports which key was tried (for the typed failure message). Mobile keychain generation deferred to M6.

**M5.6 — AddConnectionSheet + ConnectTrail.** Build the UX §3 sheet (Name / Target Local|Remote / `user@host:port` / Identity) and the transparent progress trail: `Reaching host… → SSH auth… → Forwarding control port… → Attaching… → ✓`, each step failable with a typed, actionable message (key rejected; can't reach host → reachability hint card). Reconnect reuses the trail as a dimmed overlay. Local target collapses to `Connecting… → ✓`.

### M5 Verification

```bash
xcodebuild -scheme MuxtermMac -destination 'platform=macOS' build
```

Live remote (use a second local sshd if no remote box — same code path):
```bash
# On the "remote" (can be localhost's own sshd for the test):
#   ensure sshd is running and your key is in authorized_keys
#   run a sessiond there:  ssh remote 'muxterm serve --port 8311'
#   run a dev server there: ssh remote 'python3 -m http.server 3000'
# In MuxtermMac: Add Connection → Remote → user@remote → pick key → Connect.
```
Expected observed behavior:
1. The progress trail advances through every step to `✓` (or shows a typed failure you can act on — test a wrong key → "key rejected (tried …)").
2. The remote's workspaces appear under that connection's group; opening one shows a **real terminal on the remote** (run `hostname` in the pane → prints the remote's name), proving the `-L` forward + loopback auth dividend.
3. Create a browser pane, navigate to `http://localhost:3000` → it loads the **remote's** dev server through the SOCKS channel (put a unique marker file on the remote's server and confirm it renders).
4. Terminal keeps working if the browser/SOCKS channel fails (kill the remote dev server → browser pane shows a load error, terminal unaffected — separate channels, same SSH session).

---

## Milestone M6 — iOS/iPadOS target

**Outcome:** The same codebase runs on the iOS simulator, connects to a **remote** sessiond (no local sessiond on iOS), renders a terminal with the mobile key-accessory bar, navigates panes by strip, and manages SSH keys in-app.

### Files

```
Apps/iOS/
├── MuxtermiOS.xcodeproj/ (or a target in the shared project)
├── SceneDelegate.swift
├── PaneStripView.swift           # thin rail of pane tabs/dots (touch nav)
├── KeyAccessoryBar.swift         # Esc / Ctrl / Tab / arrows / | / ~ above keyboard
├── TerminalUIView.swift          # UIView cell-grid renderer (CoreText/Metal) — mirrors macOS
└── IdentitiesView.swift          # generate / name / export-public-key / delete keys
Sources/MuxtermKit/Connectivity/
└── Identity+Keychain.swift       # generate & store keys in the iOS keychain
```

### Tasks

**M6.1 — iOS app target + shared MuxtermKit.** Add the iOS target; it links the **same** `MuxtermKit` (Protocol Client, PaneState, GhosttyVT, BrowserExecutor, SSHSession all reused unchanged — that's the payoff of putting logic in the kit). Only the views and the platform bits differ.

**M6.2 — TerminalUIView.** A `UIView` renderer mirroring `TerminalView` (M2.6): read `vt.snapshotGrid()`, draw the cell grid, derive cols/rows from the view box, send `resize`. Reuse `PaneState`/`PaneRegistry` verbatim.

**M6.3 — Key-accessory bar (essential for phone terminals).** An `inputAccessoryView` strip above the keyboard: `Esc`, `Ctrl` (sticky modifier that composes with the next key via `Keymap`), `Tab`, arrow keys, and symbols `| / ~ - …`. Wire each to `Keymap.encode → PaneState.sendInput` (UX §5).

**M6.4 — Pane strip navigation.** One pane full-screen at a time; a `PaneStripView` (dots/tabs) to swipe/tab between panes. The *visible* pane is focused (focus = authority). Workspace switcher + connection list as sheets/drawers (phone pole, UX §1/§2).

**M6.5 — iOS identities (keychain).** iOS has no `~/.ssh`. `IdentitiesView` (Settings → Identities): generate an ed25519 key into the keychain, name it, **export the public key to copy into the box's `authorized_keys`**, delete. The Add-Connection sheet's Identity picker reads from here (UX §3 mobile nuance).

**M6.6 — Responsive layout + phone `layout` blob.** Dashboard shows **remotes only** (no `Local` group — no local sessiond on iOS). Persist layout keyed `breakpoint:"phone"` so phone and desktop layouts for the same workspace are remembered separately (design §2 / UX §2).

### M6 Verification

```bash
xcodebuild -scheme MuxtermiOS -destination 'platform=iOS Simulator,name=iPhone 15' build
```

Live on the simulator against a remote sessiond:
```bash
# Run a sessiond reachable from the simulator (localhost works from the sim):
cd /home/ken/workspace/muxterm && ./bin/muxterm serve --port 8311 &
# In the iOS sim: the dashboard shows NO Local group (correct for iOS).
# Add Connection → Remote → 127.0.0.1 (a local sshd) → generate a key in
# Identities → copy its public key into ~/.ssh/authorized_keys → Connect.
```
Expected observed behavior:
1. Dashboard shows remotes only — **no** `Local` group (honest, not a broken empty group).
2. Generate a key in Identities → its public key exports/copies; adding it to `authorized_keys` lets the connection authenticate.
3. Open a workspace → a terminal renders; the key-accessory bar shows above the keyboard; `Esc`, arrows, `Ctrl`+`C` (sticky Ctrl then `c`) all work in a real shell (start `top`, press `q`, Ctrl-C a `sleep`).
4. Swipe/tab the pane strip to move between panes; the visible pane receives keystrokes.
5. The phone layout persists separately from the desktop layout for the same workspace.

---

## Deferred to later (explicitly out of scope for Phase 1)

- **Android app** — entirely separate toolchain; its own Phase 2 plan document.
- **CDP removal + the `browser-command` protocol server side** — that's **Phase 0** (Go repo). This app *consumes* those messages; it does not build them. M4's MCP-drive verification depends on Phase 0 being merged.
- **Metal cell-grid renderer** — start with CoreText for correctness (M2.6); a Metal fast-path is a later performance pass if CoreText proves too slow on large grids.
- **App-cursor-mode / bracketed-paste / full mouse-mode key encoding nuances** — M2.5 ships normal-mode arrows + core modifiers; expand the Keymap as real apps demand it.
- **DOM-snapshot / accessibility-tree browser automation** beyond the JS-injection command set — design §4 marks this YAGNI; a later design if needed.
- **NAT-traversal / Tailscale deep-linking** — muxterm *guides* (reachability hint card) but does not own NAT traversal (design §1). Ship the hint card copy; don't build traversal.
- **iPad-specific split-view polish** (two-pane tablet interpolation) — the UX doc leaves fixed-vs-adaptive to hi-fi; M6 ships the phone pole, iPad rides the responsive system without dedicated tuning this phase.
- **Multi-agent authority granularity** ("which agent, doing what") — UX open question; ship the binary `you | agent` banner now.

## Cross-cutting notes for the implementer

- **Byte-for-byte protocol fidelity is the whole game.** When in doubt about a field name or shape, the source of truth is (in order): the frozen `muxterm-client-protocol.md` from Phase 0, then `web/src/types.ts`, then the Go `sessiond` package. Never invent a field.
- **Isolate libghostty-vt churn behind `GhosttyVT.swift`** — it's the only file allowed to touch C symbols. This is the design's explicit mitigation for a pre-1.0 dependency.
- **The settle barrier is scar tissue — port it, don't redesign it.** If a race appears on Apple that the web client already fixed, the fix is almost certainly already encoded in `terminal-registry.ts`; re-read it before inventing.
- **Verify against reality every milestone.** A green `xcodebuild` proves it compiles, not that it works. The milestone is done when the live-server observation in its Verification block has actually happened.
```
