# Muxterm Browser Assistant — development extension 0.3.1

Real browser automation across the paired bridge, with one **Browser access** toggle.

## Load and connect

1. Download `muxterm-browser-assistant-dev.zip` from the Muxterm GitHub release assets and extract it on the computer running Chrome. Developers can also run `node extensions/package-browser-assistant.mjs` from their checkout to generate `extensions/muxterm-browser-assistant-dev.zip`.
2. Visit `chrome://extensions`, enable Developer mode, and **Load unpacked** the extracted `browser-assistant` folder. Pin it to the toolbar.
3. In Muxterm, open **Connections → Browser Assistant → Connect browser**.
4. While that Muxterm tab is active, click the extension’s toolbar icon and choose **Connect**. Confirm the displayed server. No address or code to paste. Manual pairing remains available under its disclosure.
5. Turn on **Browser access**. A dedicated normal Chrome window opens for agent work. Agents can navigate across HTTP/HTTPS sites and open/switch tabs within that window. Other windows remain outside their automation scope.

For an update, replace the files in the existing unpacked folder, then click **Reload** on its Chrome extensions card. Confirm version 0.3.1. Reload pauses active control; open the popup and enable access again if desired.

## Control and verification

- Access has **no time limit**. Toggle off pauses immediately and retains pairing. Turning on again creates a fresh window; old windows are not automatically reauthorized.
- Browser restarts leave access paused. The server currently keeps pairings in memory: a Muxterm server restart requires re-pairing.
- **Control this tab** adopts the tab from which the popup was opened. It remains restricted to that tab’s current origin; leaving the site pauses control.
- Chrome’s debugger banner is expected while access is active. It cannot be hidden by this extension.
- Agent tools: `list_browser_assistants`, `browser_action`, `get_browser_action`, `stop_browser_control`. Actions: `inspect`, `screenshot`, `navigate`, `click`, `type`, `key`, `scroll`, `tabs`, `new_tab`, `select_tab`. Supply `tab_id` from `tabs` for `select_tab`.
- Wait for each action to reach a terminal state before another. Cancellation does not undo actions already dispatched. Screenshots are returned as MCP JPEG image content.
- Result history is bounded. Under memory pressure, only this connection’s older results may be evicted; if other connections fill the shared budget, a new result is omitted with an explicit error. A failed, cancelled, or expired result does not prove that its action never executed.

## Permissions and boundaries

Pairing alone does not expose page contents. Enabling access authorizes agents on the paired server account to use signed-in sessions, read visible contents, screenshot, type, and submit forms. Those actions can make irreversible changes. The current single-owner server shares authorization across its agents; this is not yet per-agent consent or full multi-user isolation.

The extension requests access to the exact paired server hostname. HTTPS is recommended. Non-loopback HTTP requires explicit acknowledgment because pairing credentials and browser data can be intercepted. Do not expose a `--no-auth` instance to untrusted networks.

Chrome permissions are `activeTab`, `tabs`, `scripting`, `storage`, `alarms`, and `debugger`. `tabs` permits tab metadata discovery; every automation dispatch checks the original authorization generation and the authorized window or adopted tab. No cookie API, filesystem access, raw CDP, or arbitrary agent-supplied JavaScript is exposed. DOM inspection uses fixed expressions in an isolated execution world; page contents remain untrusted and may contain secrets. Main-frame DOM selectors do not inspect cross-origin iframe contents; viewport interactions and screenshots can still operate visually.

Pairing codes are single-use and expire after five minutes; **that is not an access timeout**. Local credentials remain in trusted extension storage. Revocation invalidates the bridge token. Legacy read-only snapshot endpoints remain available for compatibility, but are not part of the popup workflow.

This is an unpacked developer prototype, not a marketplace release.
