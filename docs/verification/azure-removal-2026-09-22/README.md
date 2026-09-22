# Azure sandbox removal verification

Azure sandbox workspaces were removed; shared SSH and remote-machine support remained intact.

The original verification passed Go build/vet, web build, and static checks (0 errors,
13 warnings). Real browser and MCP checks connected a disposable SSH container
fixture running real OpenSSH, this branch’s muxterm/sessiond, and real shell processes.
No mock or stub supplied terminal output. No unit tests ran.

[Final SSH screenshot](final-ssh.png) recorded browser keyboard input and remote
terminal output. It preceded the final badge-style correction.

[PR #173](https://github.com/kenotron-ms/muxterm/pull/173) contains the detailed boundary
mapping, verification output, configuration behavior, and limitations.
