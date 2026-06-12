# GoReleaser Setup Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add GoReleaser so tagged releases produce cross-platform binaries, checksums, a changelog, and a Homebrew formula automatically via GitHub Actions.

**Architecture:** A `.goreleaser.yaml` defines the build matrix and packaging. A frontend build runs in GoReleaser `before.hooks` so the `go:embed`'d web assets exist before `go build`. A tag-triggered GitHub Actions workflow runs GoReleaser. The README gains an Install section.

**Tech Stack:** Go 1.24 (single embedded binary), GoReleaser v2, GitHub Actions, Node.js 22 (frontend build), Homebrew tap.

> **Placeholder note:** The module path is `github.com/user/muxterm`. Throughout these files, `user` is a literal placeholder. Leave it as `user` everywhere — the maintainer will do a single find-replace when publishing to the real GitHub org/repo. The Homebrew tap requires a separate `user/homebrew-tap` repo to exist before brew publishing works.

---

## Task 1: Add GoReleaser config

**Files:**
- Create: `.goreleaser.yaml`

**Step 1: Create `.goreleaser.yaml`**

```yaml
# .goreleaser.yaml
version: 2

before:
  hooks:
    - go mod tidy
    - npm --prefix web ci --prefer-offline
    - npm --prefix web run build

builds:
  - id: muxterm
    main: ./cmd/muxterm
    binary: muxterm
    env:
      - CGO_ENABLED=0
    goos:
      - linux
      - darwin
      - windows
    goarch:
      - amd64
      - arm64
    ignore:
      - goos: windows
        goarch: arm64
    ldflags:
      - -s -w

archives:
  - formats:
      - tar.gz
    name_template: "{{ .ProjectName }}_{{ .Os }}_{{ .Arch }}"
    format_overrides:
      - goos: windows
        formats:
          - zip
    files:
      - README.md
      - LICENSE

checksum:
  name_template: "checksums.txt"

changelog:
  sort: asc
  filters:
    exclude:
      - "^docs:"
      - "^chore:"
      - "^test:"
      - "^style:"
      - Merge pull request
      - Merge branch

brews:
  - name: muxterm
    homepage: "https://github.com/user/muxterm"
    description: "Web-first terminal multiplexer with MCP agent integration"
    license: "MIT"
    repository:
      owner: user
      name: homebrew-tap
      branch: main
    folder: Formula
    install: |
      bin.install "muxterm"
    test: |
      system "#{bin}/muxterm", "version"
```

**Step 2: Verify the project still builds**

GoReleaser is NOT run locally — this is the build gate.

Run: `go build ./...`
Expected: exits 0 with no output.

If `goreleaser` happens to be installed locally, you may additionally run `goreleaser check`
Expected: `1 configuration file(s) validated` (or equivalent success). This is optional — `go build ./...` is the required gate.

**Step 3: Commit**

`git add .goreleaser.yaml && git commit -m "chore: add goreleaser config"`

---

## Task 2: Add the release workflow

**Files:**
- Create: `.github/workflows/release.yml`

> The existing `.github/workflows/pr-review.yml` is untouched — this is a new, separate workflow.

**Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-go@v5
        with:
          go-version-file: 'go.mod'
          cache: true

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: web/package-lock.json

      - name: Run GoReleaser
        uses: goreleaser/goreleaser-action@v6
        with:
          distribution: goreleaser
          version: latest
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Uncomment after creating the homebrew-tap repo and adding the secret:
          # HOMEBREW_TAP_GITHUB_TOKEN: ${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}
```

> The `HOMEBREW_TAP_GITHUB_TOKEN` line is intentionally commented out. The maintainer enables it once they create a `user/homebrew-tap` repo and add a Personal Access Token (with `contents:write` on that tap repo) as the `HOMEBREW_TAP_GITHUB_TOKEN` repository secret. Until then, GoReleaser will skip pushing the Homebrew formula or fail only on that step — keep it commented for the first release.

**Step 2: Verify the file is valid YAML**

Run: `yamllint .github/workflows/release.yml`
Expected: no errors (warnings about line length are acceptable).

If `yamllint` is not installed, fall back to a parse check:
Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"`
Expected: `valid yaml`

**Step 3: Commit**

`git add .github/workflows/release.yml && git commit -m "ci: add release workflow"`

---

## Task 3: Add an Install section to the README

**Files:**
- Modify: `README.md` (insert between line 3, the tagline paragraph, and line 5, `## What is this?`)

**Step 1: Insert the Install section**

In `README.md`, the file currently reads:

```markdown
1  # muxterm
2
3  A web-first terminal multiplexer. Persistent sessions, split panes, and a browser UI — backed by a custom Go session daemon, not tmux.
4
5  ## What is this?
```

Insert the following section so it appears AFTER the line-3 tagline paragraph and BEFORE `## What is this?` (i.e., the new `## Install` heading becomes the new line 5, pushing `## What is this?` down):

````markdown
## Install

### macOS — Homebrew
```bash
brew install user/tap/muxterm
```

### macOS / Linux — curl
```bash
curl -fsSL https://github.com/user/muxterm/releases/latest/download/muxterm_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz | tar -xz -C /usr/local/bin muxterm
```

### Go install (builds from source — requires Go 1.22+ and Node.js 18+)
```bash
go install github.com/user/muxterm/cmd/muxterm@latest
```

### Windows — Scoop (coming soon)

Pre-built binaries for each platform are attached to every [GitHub Release](https://github.com/user/muxterm/releases).

> **Note:** Replace `user` in the install commands with the real GitHub username once the repo is published.
````

> Keep `user` as the literal placeholder throughout — do NOT substitute a real name. The trailing note tells readers to find-replace it.

**Step 2: Verify the README renders correctly**

Run: `git diff README.md`
Expected: the diff shows only the new `## Install` block inserted between the tagline and `## What is this?`; no existing content removed or reflowed.

Confirm by eye that:
- The new `## Install` heading sits directly after the line-3 tagline.
- `## What is this?` and the architecture diagram below it are unchanged.
- All fenced code blocks are balanced (the outer block uses four backticks; the inner blocks use three) so nothing renders broken.

**Step 3: Commit**

`git add README.md && git commit -m "docs: add install section to README"`

---

## Done

After all three tasks: `git log --oneline -3` should show the three conventional commits (`docs:`, `ci:`, `chore:`). The first real release happens by pushing a `v*` tag (e.g., `git tag v0.1.0 && git push origin v0.1.0`), which triggers the release workflow — but tagging is the maintainer's call, not part of this plan.
````
