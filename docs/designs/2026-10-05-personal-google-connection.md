# Personal Google connections after Workspace Preview

## Decision

Remove the Google Workspace Developer Preview presets from the new-connection catalog. Preserve saved Preview connections and their read-tool settings in the Google panel for enrolled Workspace accounts. Do not present those endpoints as a personal Gmail path. Build a separate personal and work Google connection around an existing local MCP server after the OAuth app and headless browser flow are ready. The preferred candidate is [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp), not a Muxterm implementation of the Gmail, Drive, or Calendar APIs.

This document is a design, not a claim that personal Google sign-in works today.

## Why these servers differ

Google's [Workspace MCP Developer Preview](https://developers.google.com/workspace/guides/configure-mcp-servers) serves enrolled Workspace accounts and cannot be used as a general personal `@gmail.com` connection. Saved Preview connections remain available to eligible users, but the catalog no longer creates new ones.

The candidate community server offers Gmail, Drive, Calendar, Docs, Sheets, and Slides through one process, with local stdio and HTTP transports, read-only mode, and an MIT license. Its [stdio sign-in starts a callback listener on the server's localhost](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/auth/oauth_callback_server.py). A browser on another machine cannot reach that listener without forwarding. For a headless Muxterm host, use its HTTP transport behind Muxterm's authenticated public origin, route its callback through that origin, and keep its upstream listener bound to loopback. Treat its own OAuth 2.1 mode as the authority for Google sessions; do not translate its service tools or implement Google API calls in Muxterm.

[`googleworkspace/cli`](https://github.com/googleworkspace/cli) is another possible service: it has an MCP mode, prebuilt binaries, and personal account use. The current `v0.22.5` login source uses a loopback callback; its documented headless flow requires login on another computer followed by credential export. That would recreate the user's setup problem, so do not switch the catalog to it unless its headless sign-in changes or Muxterm can provide a real browser callback. The project also calls itself an unsupported Google product and warns of breaking changes before 1.0.

## OAuth and deployment gate

1. Register one Muxterm-controlled Google OAuth app with an External audience and the required Google APIs enabled. Keep the client secret in local server configuration, never in the repository or browser. Google requires a registered OAuth client for every app; using someone else's published client ID is not a sound product path.
2. Choose the exact Gmail, Drive, and Calendar scopes before registration. Start with read-only access and expand only when the UI has an explicit tool enable step. Gmail reading uses a restricted scope and a public app needs Google's verification; an unverified Testing app is limited to test users, and refresh tokens for external Testing apps expire after seven days. Do not advertise broad public sign-in during that state. [Google OAuth verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [restricted scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [testing token lifetime](https://developers.google.com/identity/protocols/oauth2#expiration).
3. Have Muxterm download a pinned, verified version of the chosen server and its runtime into the per-user data directory, as the GitHub connection does. No user-installed `uv`, Python, or CLI should be required. Check the vendor release and dependency supply chain before choosing the pin.
4. Keep the vendor server bound to loopback. Expose only the authenticated callback and MCP bridge routes through Muxterm's existing origin, with exact redirect URI registration, state/PKCE validation owned by the vendor, and per-user session isolation. Do not add a second unauthenticated public listener.
5. Show one Google account connection in the catalog, then service-specific tool groups. Only discovered tools the user enables reach new Codex, Claude, and Amplifier chats. Preserve the account's identity visibly so work and personal grants are not confused. Disconnect revokes or removes the local grant and stops exposing tools to new chats.

## Release proof required

Use a fresh `make dev-local` instance and a real browser to complete Google consent on a headless Linux host from another device or browser origin. Prove a personal `@gmail.com` account can list one Gmail message, one Drive file, and one Calendar event through the vendor MCP session, then verify the same enabled tools appear in new chats across harnesses. Capture a screenshot of the connected account and tool choice for the PR. Repeat with a Workspace account if available. A static build and catalog screenshot alone are insufficient to claim the personal connector works.

The app registration, Google verification, and a real account authorization are outstanding gates. Until those exist, the catalog must say the personal path is unavailable.
