# muxterm vision

Muxterm is a browser workspace for persistent terminals and agent work. A person should be able to leave a session, return from another device, and understand what is running, what needs attention, and what happened while they were away.

## Product promises

- **Terminals stay useful across reconnects.** The daemon owns real PTYs and screen state. The browser can detach and reconnect without becoming the source of truth for a shell.
- **Work is visible without a pane.** Agent sessions are durable records with lifecycle and transcript data. A terminal is an optional place to interact with a session, not the session's identity.
- **Mission Control is one continuous conversation.** The server owns its queue, approvals, and persisted history. Workspaces organize terminals; they do not split the conversation.
- **Attention has a trustworthy source.** Shell and agent lifecycle reports, foreground process state, and daemon-owned close decisions carry authority. Terminal text and browser timing do not.
- **Local use stays simple.** Terminal and workspace features work without an AI provider. AI setup is optional and explicit.

## Experience

The browser presents workspaces, panes, a session fleet, Mission Control, and optional agent chats in one place. A user can move between desktop and mobile views without learning a second terminal protocol. The interface should make running work and risky actions legible while leaving the terminal itself in control of terminal content.

## Boundaries

Muxterm is not a tmux control-mode client. Sessiond owns its own PTYs, and the browser renders them with xterm.js. Mission Control does not route conversation history by workspace. Agent activity is reported by native hooks and daemon state, not guessed from terminal output.

This page states the current direction. [ARCHITECTURE.md](ARCHITECTURE.md) describes the implementation and authority boundaries; [docs/README.md](docs/README.md) indexes contracts and historical designs.
