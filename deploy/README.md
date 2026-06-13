# Deploying muxterm.ampbox.io (private)

Serves the muxterm browser terminal at **https://muxterm.ampbox.io**, gated by
**GitHub OAuth** so only Ken's GitHub account can reach it.

> ☠️ **Why this matters:** muxterm trusts loopback and has **no auth of its own**.
> Reaching it = a shell on this machine. The oauth2-proxy gate is the ONLY thing
> making it private. Never expose muxterm (:8311) or the old `:8090` hop directly.

```
 Internet ──TLS──> Caddy (muxterm.ampbox.io)          [/mnt/services/muxterm.caddy]
                       └─ reverse_proxy 10.66.204.209:4181
                           oauth2-proxy  ──GitHub OAuth, allowlist=kenotron-ms──┐
                           (amplifier-muxterm-oauth.service, 0.0.0.0:4181)      │ authorized
                                                                                ▼
                                                  muxterm serve  127.0.0.1:8311 (loopback)
                                                  (amplifier-muxterm-serve.service)
```

This mirrors the **wiki.ampbox.io** setup exactly (same oauth2-proxy + Caddy
shape); muxterm just uses port **4181** (the wiki holds 4180) and proxies a
WebSocket app.

## Reusing the wiki's GitHub OAuth App (no new app)

A GitHub **OAuth App** registers a single callback URL, so muxterm can't have its
own callback on the same app. Instead we share the oauth2-proxy session **cookie
across `*.ampbox.io`**: the OAuth dance lands on the wiki's registered callback,
sets a cookie on `.ampbox.io`, and bounces back to muxterm. This is the
documented oauth2-proxy multi-subdomain pattern (`cookie-domain` +
`whitelist-domain`).

## What the agent did (no sudo) — muxterm is fully wired and the gate is UP

- Wrote the deploy artifacts in `deploy/` (this dir).
- Installed the systemd **user** units `amplifier-muxterm-serve.service` and
  `amplifier-muxterm-oauth.service` into `~/.config/systemd/user/`.
- `~/.config/amplifier-muxterm/oauth.env` (`0600`) now **reuses the wiki app**:
  same `CLIENT_ID` / `CLIENT_SECRET` / `COOKIE_SECRET`, `REDIRECT_URL` = wiki's
  callback, `COOKIE_DOMAINS` / `WHITELIST_DOMAINS` = `.ampbox.io`.
- Updated the **wiki** gate (`~/.config/amplifier-wiki/oauth.env`, backed up
  alongside) to add the same two `.ampbox.io` lines, and restarted
  `amplifier-wiki-oauth.service` (verified still serving — `403`).
  ⚠️ This widened the wiki's cookie scope, so your current wiki login is
  invalidated once — just re-login next visit.
- Started `amplifier-muxterm-oauth.service` on `0.0.0.0:4181` and verified:
  `/` → `403` sign-in, `/oauth2/start` → `302` to GitHub with
  `redirect_uri=https://wiki.ampbox.io/oauth2/callback`. The shared-app flow works.

> `amplifier-muxterm-serve.service` is installed but **not** enabled — muxterm is
> still your hand-run `./bin/muxterm serve` on `:8311`. To hand it to systemd:
> stop the manual process, then `systemctl --user enable --now amplifier-muxterm-serve.service`.

## What you (Ken) still need to do

### 1. Publish the Caddy vhost (privileged — needs write to /mnt/services)
```bash
sudo cp /home/ken/workspace/muxterm/deploy/muxterm.caddy /mnt/services/muxterm.caddy
caddy reload   # from the dir holding your main Caddyfile (admin API on :2019)
```

### 5. Retire the old unauthenticated hop
The repo's top-level `Caddyfile` runs a hand-started Caddy on `*:8090` that
reverse-proxies straight to muxterm with **no auth**. Once step 4 is live, kill
it so muxterm can't be reached around the gate:
```bash
pkill -f 'caddy run --config ./Caddyfile'   # the :8090 instance hop
ss -ltn | grep 8090                          # confirm it's gone
```

### 6. Verify
Open `https://muxterm.ampbox.io` → GitHub login → only your account gets in;
everyone else is rejected. Confirm a terminal opens and the WebSocket connects.

## Reinstall from scratch
```bash
bash /home/ken/workspace/muxterm/deploy/install.sh
```

## Notes
- **Secrets** live only in `~/.config/amplifier-muxterm/oauth.env` (`0600`),
  never in git. Only `oauth.env.example` is committed.
- **WebSockets:** oauth2-proxy proxies them by default
  (`OAUTH2_PROXY_PROXY_WEBSOCKETS=true`); once the browser has the session
  cookie, the `/ws` upgrade passes straight through.
- **Session length:** the github provider has no refresh token, so after the
  oauth2-proxy cookie expires (default 168h) you re-auth with GitHub.
- **muxterm's own auth** (`internal/server/auth.go` localhost bypass + 30s
  token) is now just a loopback safety net behind the gate — left in place; the
  real boundary is oauth2-proxy.
