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

usage() {
  printf "muxterm installer\n\n"
  printf "Usage: install.sh [OPTIONS]\n\n"
  printf "Options:\n"
  printf "  --version <ver>     Install a specific version (e.g. v0.2.1). Default: latest.\n"
  printf "  --no-modify-path    Skip adding ~/.local/bin to shell RC files.\n"
  printf "  --force             Install even on macOS instead of recommending Homebrew.\n"
  printf "  --help              Show this help.\n"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ]; then
        printf "${RED}error:${RESET} --version requires an argument\n" >&2
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
  rm -rf "$MUXTERM_TMP"
}
trap cleanup EXIT

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
    printf "${RED}error:${RESET} Windows is not supported — muxterm requires Unix PTYs.\n" >&2
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
  printf "${YELLOW}note:${RESET} WSL detected. muxterm runs, but browser auto-open may not work inside WSL.\n"
fi

# ---------------------------------------------------------------------------
# macOS redirect (unless --force)
# ---------------------------------------------------------------------------
if [ "$OS" = "darwin" ] && [ "$FORCE" = "0" ]; then
  printf "\n"
  printf "${BOLD}muxterm is available via Homebrew on macOS:${RESET}\n"
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
  printf "${RED}error:${RESET} no checksum tool found (need sha256sum or shasum)\n" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve version
# ---------------------------------------------------------------------------
if [ -z "$VERSION" ]; then
  printf "Fetching latest version... "
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  printf "%s\n" "$VERSION"
fi

if [ -z "$VERSION" ]; then
  printf "${RED}error:${RESET} could not determine latest version.\n" >&2
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
  printf "${RED}FAILED${RESET}\n" >&2
  printf "${RED}error:${RESET} %s not found in checksums.txt\n" "$TARBALL" >&2
  exit 1
fi

ACTUAL="$("${SHASUM_CMD[@]}" "$MUXTERM_TMP/$TARBALL" | awk '{print $1}')"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf "${RED}FAILED${RESET}\n" >&2
  printf "${RED}error:${RESET} checksum mismatch for %s\n" "$TARBALL" >&2
  printf "  expected: %s\n" "$EXPECTED" >&2
  printf "  actual:   %s\n" "$ACTUAL" >&2
  exit 1
fi

printf "${GREEN}ok${RESET}\n"

# ---------------------------------------------------------------------------
# Extract and install
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
tar -xzf "$MUXTERM_TMP/$TARBALL" -C "$MUXTERM_TMP" muxterm
chmod +x "$MUXTERM_TMP/muxterm"

# Detect existing install for upgrade message
PREV_VERSION=""
if [ -x "$INSTALL_DIR/muxterm" ]; then
  PREV_VERSION="$("$INSTALL_DIR/muxterm" version 2>/dev/null | awk '{print $NF}' || true)"
fi

INSTALL_ACTION="Installing"
if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$VERSION" ]; then
  INSTALL_ACTION="Upgrading"
fi

printf "%s muxterm to %s/muxterm...\n" "$INSTALL_ACTION" "$INSTALL_DIR"
mv "$MUXTERM_TMP/muxterm" "$INSTALL_DIR/muxterm"

# ---------------------------------------------------------------------------
# Service setup / restart
# ---------------------------------------------------------------------------
if [ "$INSTALL_ACTION" = "Upgrading" ]; then
  # Restart the existing service with the new binary
  systemctl --user restart muxterm 2>/dev/null || true
else
  # First install — register the systemd user service
  "$INSTALL_DIR/muxterm" install
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
  PATH_EXPORT='export PATH="$HOME/.local/bin:$PATH"'

  case "$SHELL_NAME" in
    bash)
      for rc in "$HOME/.bashrc" "$HOME/.bash_profile"; do
        if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
          printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
        fi
      done
      MODIFIED_FILE="~/.bashrc and ~/.bash_profile"
      SOURCE_CMD="source ~/.bashrc"
      ;;
    zsh)
      rc="$HOME/.zshrc"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
      fi
      MODIFIED_FILE="~/.zshrc"
      SOURCE_CMD="source ~/.zshrc"
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      mkdir -p "$(dirname "$rc")"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by muxterm installer\nset -gx PATH "$HOME/.local/bin" $PATH\n' >> "$rc"
      fi
      MODIFIED_FILE="~/.config/fish/config.fish"
      SOURCE_CMD="source ~/.config/fish/config.fish"
      ;;
    *)
      rc="$HOME/.profile"
      if ! grep -qF '.local/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by muxterm installer\n%s\n' "$PATH_EXPORT" >> "$rc"
      fi
      MODIFIED_FILE="~/.profile"
      SOURCE_CMD="source ~/.profile"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Print result
# ---------------------------------------------------------------------------
printf "\n"

if [ "$INSTALL_ACTION" = "Upgrading" ]; then
  printf "${GREEN}${BOLD}muxterm upgraded %s → %s${RESET}\n" "$PREV_VERSION" "$VERSION"
  printf "Service restarted via systemctl --user restart muxterm\n"
else
  printf "${GREEN}${BOLD}muxterm %s installed and running${RESET}\n" "$VERSION"
  printf "\n"
  printf "  Open: ${BOLD}http://localhost:8311${RESET}\n"
  printf "\n"
  printf "  muxterm doctor              # check daemon and service status\n"
  printf "\n"
  printf "To keep running after logout (optional, requires sudo once):\n"
  printf "  sudo loginctl enable-linger %s\n" "$USER"
fi

if [ -n "$MODIFIED_FILE" ]; then
  printf "\n"
  printf "${YELLOW}~/.local/bin added to PATH in %s${RESET}\n" "$MODIFIED_FILE"
  printf "Run: ${BOLD}%s${RESET}\n" "$SOURCE_CMD"
fi

printf "\n"
