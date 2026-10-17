# Muxterm Browser Assistant — development extension 0.4.0

Real browser automation across the paired bridge, with one **Browser access** toggle.

## Load and connect

1. Download `muxterm-browser-assistant-dev.zip` from the Muxterm GitHub release assets and extract it on the computer running Chrome. Developers can also run `node extensions/package-browser-assistant.mjs` from their checkout to generate `extensions/muxterm-browser-assistant-dev.zip`.
2. Visit `chrome://extensions`, enable Developer mode, and **Load unpacked** the extracted `browser-assistant` folder. Pin it to the toolbar.
3. In the extension, choose **Add**, enter a friendly name and Muxterm URL, and save. Saved instances and credentials stay in this Chrome profile, not Chrome sync. Non-loopback HTTP requires explicit acknowledgment.
4. Select an instance and choose **Connect**. If not already paired, get a fresh code from **Connections → Browser Assistant → Connect browser** in that Muxterm and paste it into the extension. Pairing never enables browser access automatically. The PWA and extension can be in different browsers; only the URL and pairing code need to cross between them.
5. Turn on **Browser access**. A dedicated normal Chrome window opens for agent work. Agents can navigate across HTTP/HTTPS sites and open/switch tabs within that window. Other windows remain outside their automation scope.

For an update, replace the files in the existing unpacked folder, then click **Reload** on its Chrome extensions card. Confirm version 0.4.0. Reload pauses active control; open the popup and enable access again if desired. Existing single-instance pairing is migrated automatically.

## Saved instances

- **Add / Edit / Remove** manage names and URLs locally. Removal asks for confirmation and deletes this browser’s saved pairing; it does not revoke the connection on the server. Revoke it in Muxterm if needed.
- **Disconnect** stops access while remembering the pairing. **Connect** reuses valid credentials and asks for a new code after server revocation or restart.
- Only one instance can be active. Selecting another or adding a new instance disconnects the previous one first. No browser window or consent transfers between instances.
- Changing an instance’s URL stops its active control and discards its credentials. Tokens are never forwarded to a replacement URL. Renaming preserves pairing.
- Failed status polling does not block local editing, removal, or disconnect. Offline pairing remains saved; connecting does not silently turn browser access back on.

## Control and verification

- Access has **no time limit**. Toggle off pauses immediately and retains pairing. Turning on again creates a fresh window; old windows are not automatically reauthorized.
- Browser restarts leave access paused. The server currently keeps pairings in memory: a Muxterm server restart requires re-pairing.
- Chrome’s debugger banner is expected while access is active. It cannot be hidden by this extension.
- Agent tools: `list_browser_assistants`, `browser_action`, `get_browser_action`, `stop_browser_control`. Actions: `inspect`, `screenshot`, `navigate`, `click`, `type`, `key`, `scroll`, `tabs`, `new_tab`, `select_tab`. Supply `tab_id` from `tabs` for `select_tab`.
- Wait for each action to reach a terminal state before another. Cancellation does not undo actions already dispatched. Screenshots are returned as MCP JPEG image content.
- Result history is bounded. Under memory pressure, only this connection’s older results may be evicted; if other connections fill the shared budget, a new result is omitted with an explicit error. A failed, cancelled, or expired result does not prove that its action never executed.

## Permissions and boundaries

Pairing alone does not expose page contents. Enabling access authorizes agents on the paired server account to use signed-in sessions, read visible contents, screenshot, type, and submit forms. Those actions can make irreversible changes. The current single-owner server shares authorization across its agents; this is not yet per-agent consent or full multi-user isolation.

A dedicated window is a control boundary, **not a separate browser profile or cookie sandbox**. It shares this Chrome profile’s sign-ins, cookies, and site permissions. Agents can open signed-in sites inside their window, even if you also have those sites open elsewhere. Use a separate Chrome profile if you need session/data separation.

The extension requests access to the exact paired server hostname. HTTPS is recommended. Non-loopback HTTP requires explicit acknowledgment because pairing credentials and browser data can be intercepted. Do not expose a `--no-auth` instance to untrusted networks.

Chrome permissions are `tabs`, `storage`, `alarms`, and `debugger`. The extension no longer requests `activeTab` or `scripting`. Every automation dispatch checks the original authorization generation and authorized window. No cookie API, filesystem access, raw CDP, or arbitrary agent-supplied JavaScript is exposed. DOM inspection uses fixed expressions in an isolated execution world; page contents remain untrusted and may contain secrets. Main-frame DOM selectors do not inspect cross-origin iframe contents; viewport interactions and screenshots can still operate visually.

Pairing codes are single-use and expire after five minutes; **that is not an access timeout**. Local credentials remain in trusted extension storage. Revocation invalidates the bridge token. Legacy read-only snapshot endpoints remain available for compatibility, but are not part of the popup workflow.

This is an unpacked developer prototype, not a marketplace release.
