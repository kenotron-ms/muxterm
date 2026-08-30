#!/usr/bin/env bash
set -euo pipefail

# muxterm installer
# Installs the muxterm binary to ~/.local/bin — no sudo required.
#
# Usage (pipe):
#   curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh | bash
#
# Usage (with flags via bash -s):
#   curl -fsSL .../install.sh | bash -s -- --version v0.2.1
#   curl -fsSL .../install.sh | bash -s -- --no-modify-path
#
# Review first:
#   curl -fsSL .../install.sh -o install.sh && less install.sh && bash install.sh

REPO="kenotron-ms/muxterm"
INSTALL_DIR="$HOME/.local/bin"

# ---------------------------------------------------------------------------
# Colors (only when stdout is a terminal)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
VERSION=""
NO_MODIFY_PATH=0
FORCE=0
VERSION_COMMAND_TIMEOUT_SECONDS="${MUXTERM_VERSION_TIMEOUT_SECONDS:-5}"
STAGED_BINARY=""

usage() {
  printf "muxterm installer\n\n"
  printf "Usage: install.sh [OPTIONS]\n\n"
  printf "Options:\n"
  printf "  --version <ver>     Install a specific version (e.g. v0.2.1). Default: latest.\n"
  printf "  --no-modify-path    Skip adding ~/.local/bin to shell RC files.\n"
  printf "  --force             Install on macOS and request controlled replacement for an existing service.\n"
  printf "  --help              Show this help.\n"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ]; then
        printf '%serror:%s --version requires an argument\n' "$RED" "$RESET" >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --no-modify-path)
      NO_MODIFY_PATH=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf "${RED}error:${RESET} unknown flag: %s\n" "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Tmpdir + cleanup trap
# ---------------------------------------------------------------------------
MUXTERM_TMP="$(mktemp -d)"

cleanup() {
  if [ -n "$STAGED_BINARY" ]; then
    rm -f "$STAGED_BINARY"
  fi
  rm -rf "$MUXTERM_TMP"
}
trap cleanup EXIT

case "$VERSION_COMMAND_TIMEOUT_SECONDS" in
  ""|*[!0-9]*|0)
    printf '%serror:%s MUXTERM_VERSION_TIMEOUT_SECONDS must be a positive integer\n' "$RED" "$RESET" >&2
    exit 1
    ;;
esac

run_bounded_version() {
  binary=$1
  stdout_path=$2
  stderr_path=$3

  if command -v timeout >/dev/null 2>&1; then
    timeout "$VERSION_COMMAND_TIMEOUT_SECONDS" "$binary" version >"$stdout_path" 2>"$stderr_path"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$VERSION_COMMAND_TIMEOUT_SECONDS" "$binary" version >"$stdout_path" 2>"$stderr_path"
    return
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -e '$seconds = shift @ARGV; alarm $seconds; exec @ARGV;' \
      "$VERSION_COMMAND_TIMEOUT_SECONDS" "$binary" version >"$stdout_path" 2>"$stderr_path"
    return
  fi

  printf '%serror:%s cannot bound muxterm version execution (need timeout, gtimeout, or perl)\n' "$RED" "$RESET" >&2
  return 125
}

read_binary_version() {
  binary=$1
  label=$2
  version_stdout="$MUXTERM_TMP/${label}-version.stdout"
  version_stderr="$MUXTERM_TMP/${label}-version.stderr"

  if ! run_bounded_version "$binary" "$version_stdout" "$version_stderr"; then
    if [ -s "$version_stderr" ]; then
      cat "$version_stderr" >&2
    fi
    return 1
  fi

  line_count="$(awk 'END { print NR }' "$version_stdout")"
  if [ "$line_count" -ne 1 ]; then
    return 1
  fi
  version_line=""
  IFS= read -r version_line <"$version_stdout" || [ -n "$version_line" ]
  if ! printf '%s\n' "$version_line" | LC_ALL=C grep -Eq '^muxterm [^[:space:]]+ \(MCP: stdio\)$'; then
    return 1
  fi

  version_line="${version_line#muxterm }"
  version_line="${version_line% (MCP: stdio)}"
  printf '%s\n' "$version_line"
}

classify_service_outcome() {
  service_status=$1
  service_stdout=$2
  service_stderr=$3
  committed_count="$(awk '$0 == "muxterm replacement outcome: committed" { count++ } END { print count + 0 }' "$service_stdout")"
  current_count="$(awk '$0 == "muxterm replacement outcome: current" { count++ } END { print count + 0 }' "$service_stdout")"
  deferred_count="$(awk '/^error: replacement deferred:/ { count++ } END { print count + 0 }' "$service_stderr")"
  legacy_count="$(awk '/^error: replacement legacy-deferred:/ { count++ } END { print count + 0 }' "$service_stderr")"
  failed_count="$(awk '/^error: replacement failed:/ { count++ } END { print count + 0 }' "$service_stderr")"

  if [ "$service_status" -eq 0 ] &&
    [ "$committed_count" -eq 1 ] &&
    [ "$current_count" -eq 0 ] &&
    [ "$deferred_count" -eq 0 ] &&
    [ "$legacy_count" -eq 0 ] &&
    [ "$failed_count" -eq 0 ]; then
    printf 'committed\n'
    return
  fi
  if [ "$service_status" -eq 0 ] &&
    [ "$committed_count" -eq 0 ] &&
    [ "$current_count" -eq 1 ] &&
    [ "$deferred_count" -eq 0 ] &&
    [ "$legacy_count" -eq 0 ] &&
    [ "$failed_count" -eq 0 ]; then
    printf 'current\n'
    return
  fi
  if [ "$service_status" -ne 0 ] &&
    [ "$committed_count" -eq 0 ] &&
    [ "$current_count" -eq 0 ] &&
    [ "$deferred_count" -eq 1 ] &&
    [ "$legacy_count" -eq 0 ] &&
    [ "$failed_count" -eq 0 ]; then
    printf 'deferred\n'
    return
  fi
  if [ "$service_status" -ne 0 ] &&
    [ "$committed_count" -eq 0 ] &&
    [ "$current_count" -eq 0 ] &&
    [ "$deferred_count" -eq 0 ] &&
    [ "$legacy_count" -eq 1 ] &&
    [ "$failed_count" -eq 0 ]; then
    printf 'legacy-deferred\n'
    return
  fi
  printf 'failed\n'
}

validate_release_version() {
  case "$1" in
    ""|*[![:alnum:].+_-]*)
      return 1
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Detect OS and architecture
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

# Normalize OS — bash 3.2 compatible (no ${var,,})
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    printf '%serror:%s Windows is not supported — muxterm requires Unix PTYs.\n' "$RED" "$RESET" >&2
    printf "       Use WSL2 if you need muxterm on a Windows host.\n" >&2
    exit 1
    ;;
  *)
    printf "${RED}error:${RESET} unsupported OS: %s\n" "$OS" >&2
    exit 1
    ;;
esac

# Normalize ARCH
case "$ARCH" in
  x86_64)          ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)
    printf "${RED}error:${RESET} unsupported architecture: %s\n" "$ARCH" >&2
    exit 1
    ;;
esac

# WSL detection — informational only, not a blocker
if [ "$OS" = "linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  printf '%snote:%s WSL detected. muxterm runs, but browser auto-open may not work inside WSL.\n' "$YELLOW" "$RESET"
fi

# ---------------------------------------------------------------------------
# macOS redirect (unless --force)
# ---------------------------------------------------------------------------
if [ "$OS" = "darwin" ] && [ "$FORCE" = "0" ]; then
  printf "\n"
  printf '%smuxterm is available via Homebrew on macOS:%s\n' "$BOLD" "$RESET"
  printf "\n"
  printf "  brew install kenotron-ms/tap/muxterm\n"
  printf "\n"
  printf "To install anyway (no Homebrew), re-run with --force\n"
  printf "\n"
  exit 0
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "${RED}error:${RESET} required command not found: %s\n" "$1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar

# Prefer sha256sum (Linux); fall back to shasum (macOS)
if command -v sha256sum >/dev/null 2>&1; then
  SHASUM_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHASUM_CMD=(shasum -a 256)
else
  printf '%serror:%s no checksum tool found (need sha256sum or shasum)\n' "$RED" "$RESET" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve version
# ---------------------------------------------------------------------------
if [ -z "$VERSION" ]; then
  printf "Fetching latest version... "
  LATEST_RELEASE="$MUXTERM_TMP/latest-release.json"
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" -o "$LATEST_RELEASE"
  VERSION="$(LC_ALL=C sed -nE 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)"[[:space:]]*,?[[:space:]]*$/\1/p' "$LATEST_RELEASE")"
  printf "%s\n" "$VERSION"
fi

if ! validate_release_version "$VERSION"; then
  printf '%serror:%s could not determine a valid release version.\n' "$RED" "$RESET" >&2
  printf "       Try: --version v0.2.1\n" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Download tarball + checksums
# ---------------------------------------------------------------------------
TARBALL="muxterm_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"

printf "Downloading muxterm %s (%s/%s)...\n" "$VERSION" "$OS" "$ARCH"
curl -fsSL "$URL" -o "$MUXTERM_TMP/$TARBALL"
curl -fsSL "$CHECKSUMS_URL" -o "$MUXTERM_TMP/checksums.txt"

# ---------------------------------------------------------------------------
# Verify checksum
# ---------------------------------------------------------------------------
printf "Verifying checksum... "

EXPECTED="$(grep "$TARBALL" "$MUXTERM_TMP/checksums.txt" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  printf '%sFAILED%s\n' "$RED" "$RESET" >&2
  printf "${RED}error:${RESET} %s not found in checksums.txt\n" "$TARBALL" >&2
  exit 1
fi

ACTUAL="$("${SHASUM_CMD[@]}" "$MUXTERM_TMP/$TARBALL" | awk '{print $1}')"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf '%sFAILED%s\n' "$RED" "$RESET" >&2
  printf "${RED}error:${RESET} checksum mismatch for %s\n" "$TARBALL" >&2
  printf "  expected: %s\n" "$EXPECTED" >&2
  printf "  actual:   %s\n" "$ACTUAL" >&2
  exit 1
fi

printf '%sok%s\n' "$GREEN" "$RESET"

# ---------------------------------------------------------------------------
# Extract and install
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
tar -xzf "$MUXTERM_TMP/$TARBALL" -C "$MUXTERM_TMP" muxterm
chmod +x "$MUXTERM_TMP/muxterm"

# A valid prior binary is the only basis for upgrade behavior. Do not replace a
# malformed or unknown incumbent with a release that cannot safely classify it.
HAS_PREVIOUS=0
if [ -e "$INSTALL_DIR/muxterm" ] || [ -L "$INSTALL_DIR/muxterm" ]; then
  if [ ! -x "$INSTALL_DIR/muxterm" ] || ! read_binary_version "$INSTALL_DIR/muxterm" previous >/dev/null; then
    printf '%serror:%s existing muxterm binary has an unknown or malformed version; leaving it unchanged.\n' "$RED" "$RESET" >&2
    exit 1
  fi
  HAS_PREVIOUS=1
fi

INSTALL_ACTION="Installing"
if [ "$HAS_PREVIOUS" = "1" ]; then
  INSTALL_ACTION="Upgrading"
fi

# Publish only a fully validated staged binary. The stage is in INSTALL_DIR so
# the final rename cannot cross a filesystem boundary.
if [ -d "$INSTALL_DIR/muxterm" ]; then
  printf "${RED}error:${RESET} %s/muxterm is a directory; leaving it unchanged.\n" "$INSTALL_DIR" >&2
  exit 1
fi
STAGED_BINARY="$(mktemp "$INSTALL_DIR/.muxterm.XXXXXX")"
cp "$MUXTERM_TMP/muxterm" "$STAGED_BINARY"
chmod 0755 "$STAGED_BINARY"
if ! STAGED_VERSION="$(read_binary_version "$STAGED_BINARY" staged)"; then
  printf '%serror:%s staged muxterm binary did not report a valid version; leaving the existing binary unchanged.\n' "$RED" "$RESET" >&2
  exit 1
fi
if [ "$STAGED_VERSION" != "$VERSION" ]; then
  printf "${RED}error:${RESET} staged muxterm version %s does not match requested release %s; leaving the existing binary unchanged.\n" \
    "$STAGED_VERSION" "$VERSION" >&2
  exit 1
fi

printf "%s muxterm to %s/muxterm...\n" "$INSTALL_ACTION" "$INSTALL_DIR"
mv -f "$STAGED_BINARY" "$INSTALL_DIR/muxterm"
STAGED_BINARY=""

# ---------------------------------------------------------------------------
# Service setup / controlled replacement
# ---------------------------------------------------------------------------
SERVICE_STDOUT="$MUXTERM_TMP/service-install.stdout"
SERVICE_STDERR="$MUXTERM_TMP/service-install.stderr"
SERVICE_STATUS=0
if [ "$INSTALL_ACTION" = "Upgrading" ]; then
  if "$INSTALL_DIR/muxterm" install --force >"$SERVICE_STDOUT" 2>"$SERVICE_STDERR"; then
    SERVICE_STATUS=0
  else
    SERVICE_STATUS=$?
  fi
else
  if "$INSTALL_DIR/muxterm" install >"$SERVICE_STDOUT" 2>"$SERVICE_STDERR"; then
    SERVICE_STATUS=0
  else
    SERVICE_STATUS=$?
  fi
fi
cat "$SERVICE_STDOUT"
cat "$SERVICE_STDERR" >&2

if [ "$INSTALL_ACTION" = "Upgrading" ]; then
  SERVICE_OUTCOME="$(classify_service_outcome "$SERVICE_STATUS" "$SERVICE_STDOUT" "$SERVICE_STDERR")"
  case "$SERVICE_OUTCOME" in
    committed)
      printf "muxterm upgrade committed: sessiond replaced and protocol-ready\n"
      ;;
    current)
      printf "muxterm upgrade current: sessiond already current; web updated\n"
      ;;
    deferred)
      printf "muxterm upgrade deferred: incumbent sessiond and PTYs left running\n"
      exit "$SERVICE_STATUS"
      ;;
    legacy-deferred)
      printf "muxterm upgrade legacy-deferred: incumbent legacy sessiond and PTYs left running\n"
      exit "$SERVICE_STATUS"
      ;;
    *)
      printf "muxterm upgrade failed: replacement did not complete; no success reported\n"
      if [ "$SERVICE_STATUS" -eq 0 ]; then
        exit 1
      fi
      exit "$SERVICE_STATUS"
      ;;
  esac
elif [ "$SERVICE_STATUS" -ne 0 ]; then
  exit "$SERVICE_STATUS"
fi

# ---------------------------------------------------------------------------
# PATH detection + optional shell RC update
# ---------------------------------------------------------------------------
NEED_PATH=0
MODIFIED_FILE=""
SOURCE_CMD=""

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) NEED_PATH=0 ;;
  *)                    NEED_PATH=1 ;;
esac

if [ "$NEED_PATH" = "1" ] && [ "$NO_MODIFY_PATH" = "0" ]; then
  SHELL_NAME="$(basename "${SHELL:-bash}")"
  PATH_EXPORT="export PATH=\"\$HOME/.local/bin:\$PATH\""

  case "$SHELL_NAME" in
    bash)
      for rc in "$HOME/.bashrc" "$HOME/.bash_profile"; do
        if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
          printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
        fi
      done
      MODIFIED_FILE="$HOME/.bashrc and $HOME/.bash_profile"
      SOURCE_CMD="source $HOME/.bashrc"
      ;;
    zsh)
      rc="$HOME/.zshrc"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
      fi
      MODIFIED_FILE="$HOME/.zshrc"
      SOURCE_CMD="source $HOME/.zshrc"
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      mkdir -p "$(dirname "$rc")"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf "\n# Added by muxterm installer\nset -gx PATH \"\$HOME/.local/bin\" \$PATH\n" >> "$rc"
      fi
      MODIFIED_FILE="$HOME/.config/fish/config.fish"
      SOURCE_CMD="source $HOME/.config/fish/config.fish"
      ;;
    *)
      rc="$HOME/.profile"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
      fi
      MODIFIED_FILE="$HOME/.profile"
      SOURCE_CMD="source $HOME/.profile"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Print result
# ---------------------------------------------------------------------------
printf "\n"

if [ "$INSTALL_ACTION" = "Upgrading" ]; then
  :
else
  printf '%s%smuxterm %s installed and running%s\n' "$GREEN" "$BOLD" "$VERSION" "$RESET"
  printf "\n"
  printf '  Open: %shttp://localhost:8311%s\n' "$BOLD" "$RESET"
  printf "\n"
  printf "  muxterm doctor              # check daemon and service status\n"
  printf "\n"
  printf "To keep running after logout (optional, requires sudo once):\n"
  printf "  sudo loginctl enable-linger %s\n" "${USER:-$(id -un)}"
fi

if [ -n "$MODIFIED_FILE" ]; then
  printf "\n"
  printf '%s~/.local/bin added to PATH in %s%s\n' "$YELLOW" "$MODIFIED_FILE" "$RESET"
  printf 'Run: %s%s%s\n' "$BOLD" "$SOURCE_CMD" "$RESET"
fi

printf "\n"
