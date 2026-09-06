#!/usr/bin/env bash
# remote-fixture.sh — stand up a GENUINELY separate machine running sessiond.
#
# Why this exists: `ssh localhost muxterm sessiond-connect` reaches the SAME
# daemon (same XDG_RUNTIME_DIR), so both ends hand out identical ids and every
# namespacing bug is invisible. The §G.1 acceptance path is worthless without a
# second machine. This builds one: an Incus container with its own filesystem,
# its own hostname, and its own sessiond, reachable over real SSH on :2222.
#
# It never touches the user's ~/.ssh/config. Everything the ssh client and
# muxterm need lives under $FIXTURE_ROOT. Redirecting it takes TWO mechanisms,
# not one, because two different things look up the config independently — see
# env_block at the bottom. MUXTERM_SSH_CONFIG now covers the ssh client itself
# (the dialer passes it through as -F), and HOME covers Go's own
# os.UserHomeDir() lookup in transport.Discover.
#
#   tools/remote-fixture.sh create    build/repair the fixture, then verify it
#   tools/remote-fixture.sh destroy   delete the container and the scratch root
#   tools/remote-fixture.sh status    report what exists right now
#   tools/remote-fixture.sh env       print the exports a client needs
#
# create and destroy are idempotent: re-running create repairs a half-built
# fixture, and destroy on nothing is a no-op.

set -euo pipefail

NAME="${FIXTURE_NAME:-muxterm-remote-fixture}"
IMAGE="${FIXTURE_IMAGE:-images:debian/13}"
USER_NAME="${FIXTURE_USER:-muxfix}"
PORT="${FIXTURE_PORT:-2222}"
ALIAS="${FIXTURE_ALIAS:-muxfix}"
ROOT="${FIXTURE_ROOT:-/tmp/muxterm-remote-fixture}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO/bin/muxterm"
KEY="$ROOT/.ssh/id_ed25519"
SSH_CONFIG="$ROOT/.ssh/config"
DEVICE="ssh$PORT"

say() { printf '  %s\n' "$*"; }
die() { printf 'remote-fixture: %s\n' "$*" >&2; exit 1; }

exists() { incus info "$NAME" >/dev/null 2>&1; }
running() { [ "$(incus info "$NAME" 2>/dev/null | awk '/^Status:/{print $2}')" = "RUNNING" ]; }
inc() { incus exec "$NAME" -- "$@"; }

# ssh_fixture runs a command on the fixture with the scratch config only. No
# agent, no user config, no prompt: a failure here is a real failure, never a
# hang waiting on input nobody can answer.
ssh_fixture() {
  env -u SSH_AUTH_SOCK ssh -F "$SSH_CONFIG" -o BatchMode=yes "$ALIAS" "$@"
}

# --- create -----------------------------------------------------------------

create() {
  command -v incus >/dev/null || die "incus not on PATH"
  [ -x "$BIN" ] || die "$BIN missing — run 'make build' first"

  say "scratch root $ROOT"
  mkdir -p "$ROOT/.ssh"
  chmod 700 "$ROOT/.ssh"
  [ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -C muxterm-remote-fixture -f "$KEY" >/dev/null

  # Rewritten every run so the config always matches the current settings.
  # StrictHostKeyChecking=no is correct here and only here: the container is
  # rebuilt with a fresh host key on every create, so a pinned key would be a
  # guaranteed false failure.
  cat >"$SSH_CONFIG" <<EOF
# muxterm remote fixture — scratch config, NOT the user's ~/.ssh/config.
Host $ALIAS
    HostName 127.0.0.1
    Port $PORT
    User $USER_NAME
    IdentityFile $KEY
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking no
    UserKnownHostsFile $ROOT/.ssh/known_hosts
EOF

  # There used to be an `ssh` PATH shim here whose only job was to add -F,
  # because internal/transport/ssh ran `ssh -T -o BatchMode=yes -- <target>`
  # with no way to name a config file, and OpenSSH locates ~/.ssh/config
  # through getpwuid() rather than $HOME. baseArgs() now inserts
  # `-F $MUXTERM_SSH_CONFIG` when that variable is set, on both the Dial and
  # the Probe path, so the shim is gone: a workaround left standing after its
  # bug is fixed is a trap, because the next person cannot tell which of the
  # two is doing the work. Verified with PATH containing only the system
  # directories — `--remote $ALIAS workspace list`, Discover and Probe all
  # succeed against /usr/bin/ssh, and unsetting MUXTERM_SSH_CONFIG makes them
  # fail with "Could not resolve hostname $ALIAS", which is what proves the
  # -F is load-bearing.

  if ! exists; then
    say "launching $NAME from $IMAGE"
    incus launch "$IMAGE" "$NAME" >/dev/null
  elif ! running; then
    say "starting $NAME"
    incus start "$NAME" >/dev/null
  else
    say "$NAME already running"
  fi

  say "waiting for container network"
  for _ in $(seq 60); do
    inc getent hosts deb.debian.org >/dev/null 2>&1 && break
    sleep 1
  done
  inc getent hosts deb.debian.org >/dev/null 2>&1 || die "container has no DNS/network"

  if ! inc test -x /usr/sbin/sshd; then
    say "installing openssh-server"
    inc env DEBIAN_FRONTEND=noninteractive apt-get -qq update >/dev/null
    # libpam0g/libaudit1/libcap-ng0 are what the muxterm binary links against;
    # naming them makes a missing shared object impossible instead of latent.
    inc env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y \
      openssh-server libpam0g libaudit1 libcap-ng0 >/dev/null
  fi

  inc id "$USER_NAME" >/dev/null 2>&1 || {
    say "creating user $USER_NAME"
    inc useradd -m -s /bin/bash "$USER_NAME"
  }

  say "authorizing key on :$PORT"
  inc install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
  incus file push "$KEY.pub" "$NAME/home/$USER_NAME/.ssh/authorized_keys" \
    --uid 0 --gid 0 --mode 600 --quiet
  inc chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"

  printf 'Port %s\nPasswordAuthentication no\nPubkeyAuthentication yes\n' "$PORT" |
    inc tee /etc/ssh/sshd_config.d/muxterm-fixture.conf >/dev/null

  # Debian 13 socket-activates ssh, which makes sshd_config's Port a lie: the
  # socket unit owns the listen address. Turn socket activation off so the one
  # port setting in the config file is the one that takes effect.
  inc systemctl disable --now ssh.socket >/dev/null 2>&1 || true
  inc systemctl enable ssh.service >/dev/null 2>&1 || true
  inc systemctl restart ssh.service

  # ~/.local/bin is where a real `muxterm install` lands, and it is NOT on the
  # non-interactive ssh PATH. Installing here exercises the transport's default
  # `bash -lc` resolution rather than a friendlier path that would hide it.
  inc install -d -m 755 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.local/bin"
  # Compare before pushing. Not an optimization: a running sessiond holds the
  # file open, so an unconditional push fails with "text file busy" and makes
  # create non-idempotent the moment the fixture is actually in use.
  local want have
  want="$(sha256sum "$BIN" | cut -d' ' -f1)"
  have="$(inc sha256sum "/home/$USER_NAME/.local/bin/muxterm" 2>/dev/null | cut -d' ' -f1 || true)"
  if [ "$want" != "$have" ]; then
    say "installing muxterm to /home/$USER_NAME/.local/bin"
    inc pkill -u "$USER_NAME" -x muxterm >/dev/null 2>&1 || true
    incus file push "$BIN" "$NAME/home/$USER_NAME/.local/bin/muxterm" \
      --uid 0 --gid 0 --mode 755 --quiet
  else
    say "muxterm already current on $ALIAS ($want)"
  fi
  # -R, not just the binary: `install -d` created ~/.local as root, and sessiond
  # writes its snapshot under ~/.local/share. Leaving that root-owned turns the
  # daemon log into a permission-denied loop every 30 s.
  inc chown -R "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.local"
  inc bash -c "grep -q muxterm-fixture-path /home/$USER_NAME/.profile 2>/dev/null || \
    printf '# muxterm-fixture-path\nPATH=\"\$HOME/.local/bin:\$PATH\"\n' >> /home/$USER_NAME/.profile"

  if ! incus config device get "$NAME" "$DEVICE" listen >/dev/null 2>&1; then
    say "forwarding 127.0.0.1:$PORT into the container"
    incus config device add "$NAME" "$DEVICE" proxy \
      "listen=tcp:127.0.0.1:$PORT" "connect=tcp:127.0.0.1:$PORT" >/dev/null
  fi

  say "verifying"
  for _ in $(seq 30); do
    ssh_fixture true >/dev/null 2>&1 && break
    sleep 1
  done
  local remote_bin remote_host
  remote_bin="$(ssh_fixture 'bash -lc "command -v muxterm"')" ||
    die "ssh -p $PORT $USER_NAME@localhost failed, or muxterm is not on the login PATH"
  remote_host="$(ssh_fixture 'bash -lc "uname -n"')"

  # `muxterm sessiond-connect` refuses to spawn a daemon, by design, so a
  # mistyped host can never start one somewhere unexpected. That makes starting
  # the far-side daemon this harness's job. Lingering is what keeps it alive:
  # without it logind reaps the user's processes and deletes $XDG_RUNTIME_DIR
  # the moment the ssh session that started it ends, taking the socket with it.
  inc loginctl enable-linger "$USER_NAME" >/dev/null 2>&1 || true
  if ! ssh_fixture 'bash -lc "pgrep -x muxterm"' >/dev/null 2>&1; then
    say "starting sessiond on $ALIAS"
    ssh_fixture 'bash -lc "setsid nohup muxterm sessiond >/tmp/sessiond.log 2>&1 </dev/null & sleep 2"' >/dev/null
  fi
  local remote_sock
  # shellcheck disable=SC2016  # $XDG_RUNTIME_DIR must expand on the FAR side
  remote_sock="$(ssh_fixture 'bash -lc "ls \$XDG_RUNTIME_DIR/muxterm/sessiond.sock"')" ||
    die "sessiond did not come up on $ALIAS — see /tmp/sessiond.log there"

  say "ok: $ALIAS is $remote_host, muxterm at $remote_bin"
  say "    sessiond socket $remote_sock (the container's own /run, not this host's)"
  echo
  env_block
}

# --- destroy ----------------------------------------------------------------

destroy() {
  if exists; then
    say "deleting container $NAME"
    incus delete --force "$NAME"
  else
    say "no container $NAME"
  fi
  if [ -d "$ROOT" ]; then
    say "removing scratch root $ROOT"
    rm -rf "$ROOT"
  else
    say "no scratch root $ROOT"
  fi
}

# --- status -----------------------------------------------------------------

status() {
  if exists; then
    say "container $NAME: $(incus info "$NAME" | awk '/^Status:/{print $2}')"
    if listen="$(incus config device get "$NAME" "$DEVICE" listen 2>/dev/null)"; then
      say "proxy $DEVICE: $listen"
    else
      say "proxy $DEVICE: absent"
    fi
  else
    say "container $NAME: absent"
  fi
  if [ -f "$SSH_CONFIG" ]; then
    say "ssh config: $SSH_CONFIG"
    if out="$(ssh_fixture 'bash -lc "uname -n; command -v muxterm; pgrep -x muxterm >/dev/null && echo sessiond-up || echo sessiond-DOWN"' 2>&1)"; then
      say "ssh $ALIAS: ok ($(echo "$out" | tr '\n' ' '))"
    else
      say "ssh $ALIAS: FAILED — $out"
    fi
  else
    say "ssh config: absent"
  fi
}

# --- env --------------------------------------------------------------------

# env_block prints the environment a client needs. Two separate mechanisms are
# required because two different things look up the ssh config:
#   MUXTERM_SSH_CONFIG   the ssh CLIENT (baseArgs passes it as -F, so Dial and
#                        Probe both use it) AND sshconfig.DefaultPath(), the
#                        `remote add` writer
#   HOME                 os.UserHomeDir() — transport.Discover reads
#                        $HOME/.ssh/config and does NOT consult
#                        MUXTERM_SSH_CONFIG, so the settings list needs this
# Both land on the same scratch file, so no code path can reach the real
# ~/.ssh/config. Drop either one and something silently reads the user's.
env_block() {
  cat <<EOF
export HOME=$ROOT
export MUXTERM_SSH_CONFIG=$SSH_CONFIG
export XDG_RUNTIME_DIR=$ROOT/run
export XDG_DATA_HOME=$ROOT/.local/share
export XDG_CONFIG_HOME=$ROOT/.config
export XDG_STATE_HOME=$ROOT/.local/state
# then: ./bin/muxterm --remote $ALIAS workspace list
EOF
}

case "${1:-}" in
  create)  create ;;
  destroy) destroy ;;
  status)  status ;;
  env)     env_block ;;
  *) die "usage: $(basename "$0") {create|destroy|status|env}" ;;
esac
