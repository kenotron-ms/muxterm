#!/usr/bin/env bash
# Install muxterm's user-systemd services (no sudo needed; linger must be on).
#
#   amplifier-muxterm-serve.service  — muxterm serve on 127.0.0.1:9090 (loopback only)
#   amplifier-muxterm-oauth.service  — oauth2-proxy GitHub gate on 0.0.0.0:4181
#
# The public endpoint (muxterm.ampbox.io) is a SEPARATE, privileged step: copy
# muxterm.caddy into /mnt/services and reload Caddy (see README.md). Do NOT
# expose muxterm without the oauth gate running — it is a shell on this machine.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
ENV_DIR="${HOME}/.config/amplifier-muxterm"
ENV_FILE="${ENV_DIR}/oauth.env"

mkdir -p "${UNIT_DIR}" "${ENV_DIR}"
chmod 700 "${ENV_DIR}"

echo "==> Installing systemd user units"
cp "${DEPLOY_DIR}/systemd/"*.service "${UNIT_DIR}/"
systemctl --user daemon-reload

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${DEPLOY_DIR}/oauth.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  # Pre-fill a strong cookie secret so only the GitHub fields remain.
  SECRET="$(python3 -c 'import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())')"
  sed -i "s|^OAUTH2_PROXY_COOKIE_SECRET=.*|OAUTH2_PROXY_COOKIE_SECRET=${SECRET}|" "${ENV_FILE}"
  echo "==> Created ${ENV_FILE} (0600) with a fresh cookie secret"
  echo "    FILL IN the GitHub client id/secret (and confirm the allowlisted user)."
else
  echo "==> ${ENV_FILE} exists — leaving it untouched"
fi

echo "==> Enabling + starting muxterm serve (loopback only, safe)"
systemctl --user enable --now amplifier-muxterm-serve.service

echo
echo "muxterm serve:  http://127.0.0.1:9090   ($(systemctl --user is-active amplifier-muxterm-serve.service))"
echo
echo "NEXT (see README.md):"
echo "  1. Create a GitHub OAuth App (callback https://muxterm.ampbox.io/oauth2/callback)"
echo "  2. Fill ${ENV_FILE}"
echo "  3. systemctl --user enable --now amplifier-muxterm-oauth.service"
echo "  4. Copy muxterm.caddy into /mnt/services/ and reload Caddy  (privileged)"
echo "  5. Stop the old unauthenticated :8090 Caddy hop"
