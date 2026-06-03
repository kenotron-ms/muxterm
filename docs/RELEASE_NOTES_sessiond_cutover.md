# Release Notes: sessiond Cutover

## Summary

muxterm no longer drives tmux in control mode. Terminal sessions are now owned
by **sessiond**, muxterm's own session daemon.

## What Changed

- **tmux control mode removed.** muxterm previously launched and managed
  terminal sessions through a tmux control-mode process. That code is gone.
- **Sessions owned by sessiond.** All terminal sessions are now created and
  held by the sessiond daemon, dialed per-browser by serve/local.

## Clean Break — No Migration

Pre-existing tmux sessions are **NOT migrated**. This is a deliberate clean
break for v1: there is no migration engine. Any sessions running under your
previous tmux-backed muxterm will not appear in the new daemon. Start fresh.

On first start, serve/local log a one-time notice making this explicit.

## Persistence Model

- **New sessions persist across serve restarts.** The daemon outlives the serve
  process, so restarting `muxterm serve` (or `muxterm local`) reconnects to the
  same live sessions.
- **Only a sessiond crash loses sessions.** sessiond is supervised with
  `Restart=on-failure`, so a crash relaunches the daemon — but any sessions it
  was holding are lost in that event.

## Checking Status

Run `muxterm doctor` to check daemon status.
