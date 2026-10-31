#!/bin/sh
exec "${MUXTERM_PI_COMMAND:-pi}" --extension "$MUXTERM_PI_EXTENSION" "$@"
