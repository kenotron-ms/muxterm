---
bundle:
  name: muxterm-cos
  version: 1.0.0
  description: |
    muxterm's chief-of-staff bundle. A dispatcher, not a coding agent: the
    muxterm MCP tools plus read_file, glob, grep, web_search, web_fetch and
    todo, and nothing that can edit, run, or delegate outside a visible pane.

    Loaded by the chief-of-staff sidecar (internal/cos/sidecar/main.py). The
    sidecar shipped on --bundle anchors until v0.20.0, which gave it bash,
    write_file, edit_file, apply_patch, delegate, recipes, load_skill and mode
    -- the exact opposite of the delegation model in
    docs/designs/2026-09-06-cos-delegation-model.md section 2.

    WHERE THIS LIVES, AND WHY IT IS NOT IN behaviors/ WITH ITS SIBLING.
    muxterm ships as a single binary: the homebrew tap, the curl installer and
    the release tarball all deliver exactly one executable. A bundle that only
    exists in a source checkout does not exist on any installed machine -- the
    lesson v0.19.0 taught with the sidecar script itself (see
    internal/cos/embed.go). So this tree is compiled into the binary alongside
    main.py and extracted with it, and go:embed cannot reach a parent
    directory. The sidecar finds it at __file__/../bundle/bundle.md, which is
    true both in a source checkout and in the extracted copy, because both are
    extracted as one unit under one content digest.

    It is still an ordinary bundle. Point --bundle at this file, or register it
    by URI, and it resolves like any other.

includes:
  - bundle: muxterm-cos:behaviors/muxterm-cos

session:
  raw: true
  orchestrator:
    module: loop-streaming
    source: git+https://github.com/microsoft/amplifier-module-loop-streaming@main
    config:
      extended_thinking: true
  context:
    module: context-simple
    source: git+https://github.com/microsoft/amplifier-module-context-simple@main
    config:
      max_tokens: 300000
      compact_threshold: 0.8
      auto_compact: true
---

@muxterm-cos:context/cos-charter.md

---

@muxterm-cos:context/cos-stop-conditions.md
