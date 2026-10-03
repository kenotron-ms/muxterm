---
name: muxterm-verify
description: Verify terminal, pane, reconnect, layout, and attention behavior in a real browser against an isolated dev-local sessiond.
user-invocable: true
disable-model-invocation: true
---

# muxterm browser verification

Follow the repository's [AGENTS.md](../../../AGENTS.md) safety and verification rules. Run against `make dev-local` at `http://127.0.0.1:8313`. Ports `8311` and `9090` serve the user's live muxterm and are not verification targets.

1. Start or cleanly restart the **dev-local** stack. Confirm its sessiond binary comes from the worktree being tested. A clean pass uses a wiped dev-local runtime directory and a fresh workspace and pane.
2. Use `playwright-cli` with your own tool calls to open `http://127.0.0.1:8313`. Inspect the current UI before choosing controls or selectors. Do not edit source while the dev-local watch loop is mid-test.
3. Perform the relevant journeys below and record observed results. Use a fresh workspace for each rerun.
4. Store transient screenshots and logs under `/home/ken/artifacts/` in a task-specific directory. Close the browser when finished.
5. Report the actions, observed behavior, failures, and limitations. Static checks alone do not establish browser behavior.

Never clear caches, change workspaces, or otherwise mutate state on production ports. For installation, service manager, reverse proxy, or upgrade paths, use a Digital Twin Universe as AGENTS.md requires.

## Core journeys

- Create a workspace and pane, run a simple shell command, and check that input and output are correct.
- Create a second pane, switch between panes, refresh the browser, and check selected pane, readable screen contents, and absence of raw escape bytes or replacement characters.
- Request pane closure through the UI. Complete any daemon-required confirmation, then refresh and check that the closed pane stays absent.
- Split a pane, resize it, refresh, and check that layout and terminal contents return cleanly.
- Where relevant to the change, trigger a bell in a background pane or workspace and check that the indicator appears and clears when selected.
- Where relevant, repeat navigation and pane selection at a narrow viewport and verify that the current mobile controls are usable.

Report each observed assertion with the actual browser state. A failed or skipped journey is not a pass.
