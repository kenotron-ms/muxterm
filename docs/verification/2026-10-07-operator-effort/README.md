# Operator effort ranges

Screenshots from isolated `make dev-local` on port 8313 with real Codex lanes,
a real browser, and dev-local sessiond. The timing population in these runs
was 16 synthetic completed-turn journals; no private production chat history
was copied into the fixture.

- `running-timing.png`: a running lane shows a historical remaining-time range,
  comparable sample count, classification source, and uncertainty in the expanded row.
- `stopped-attention.png`: a cancelled turn is Stopped under Needs attention,
  with Unlink lane and Archive chat still available as distinct actions.
