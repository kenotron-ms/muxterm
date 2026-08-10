---
bundle:
  name: muxterm
  version: 1.0.0
  description: Amplifier bundle for managing muxterm — create panes, run commands, automate browser panes, manage workspaces

includes:
  - bundle: git+https://github.com/microsoft/amplifier-foundation@main
  - bundle: muxterm:behaviors/muxterm
---

@muxterm:context/muxterm-awareness.md

---

@foundation:context/shared/common-system-base.md
