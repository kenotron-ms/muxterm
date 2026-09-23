#!/bin/sh
set -eu
exec "${MUXTERM_CLAUDE_BRIDGE:?}" session claude-hook "$1"
