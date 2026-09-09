# Lane: dashboard todo progress

Goal: surface each session's structured todo progress (fraction + current item) on the
Mission Control cards, instead of the volatile per-tool-call `doing` string.

Status: T1 investigation starting. Nothing designed yet.

Tasks
- T1 is the load-bearing question: is amplifier's `todo` tool state readable outside
  the session (persisted to disk / exposed to hooks / survives session end)?
- T2 carry it on modules/hooks-muxterm-session (state.py / label.py / classify.py), no
  second reporting channel.
- T3 card shows fraction (3/10) + current in-progress item, no meaningful height growth.
- T4 sessions without todos fall back to `doing`; never render 0/0 or an empty bar.
- T5 tiles view: fraction only, or nothing.

Hard rule: no screen scraping of terminal output.
