#!/usr/bin/env python3
"""Tests that README.md contains the Install section in the correct location and with correct content."""

import sys
from pathlib import Path

README = Path(__file__).parent.parent / "README.md"

TAGLINE = "A web-first terminal multiplexer. Persistent sessions, split panes, and a browser UI \u2014 backed by a custom Go session daemon, not tmux."
WHAT_HEADING = "## What is this?"
INSTALL_HEADING = "## Install"


def read_readme():
    return README.read_text(encoding="utf-8")


def test_install_heading_exists():
    content = read_readme()
    assert INSTALL_HEADING in content, "## Install heading not found in README"


def test_install_after_tagline():
    content = read_readme()
    install_idx = content.index(INSTALL_HEADING)
    tagline_idx = content.index(TAGLINE)
    assert install_idx > tagline_idx, (
        f"## Install (pos {install_idx}) should come after tagline (pos {tagline_idx})"
    )


def test_what_is_this_after_install():
    content = read_readme()
    install_idx = content.index(INSTALL_HEADING)
    what_idx = content.index(WHAT_HEADING)
    assert what_idx > install_idx, (
        f"## What is this? (pos {what_idx}) should come after ## Install (pos {install_idx})"
    )


def test_install_immediately_after_tagline():
    """No content between tagline paragraph and ## Install except blank lines."""
    content = read_readme()
    tagline_end = content.index(TAGLINE) + len(TAGLINE)
    install_idx = content.index(INSTALL_HEADING)
    between = content[tagline_end:install_idx].strip()
    assert between == "", (
        f"Unexpected content between tagline and ## Install: {repr(between)}"
    )


def test_homebrew_subsection():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "### macOS \u2014 Homebrew" in section, "Homebrew subsection not found"
    assert "brew install user/tap/muxterm" in section, "brew install command not found"


def test_curl_subsection():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "### macOS / Linux \u2014 curl" in section, "curl subsection not found"
    assert "curl -fsSL" in section, "curl command not found"


def test_go_install_subsection():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "### Go install" in section, "Go install subsection not found"
    assert "go install github.com/user/muxterm/cmd/muxterm@latest" in section, (
        "go install command not found"
    )


def test_windows_scoop_subsection():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "### Windows \u2014 Scoop (coming soon)" in section, (
        "Windows Scoop subsection not found"
    )


def test_github_releases_link():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "GitHub Release" in section, "GitHub Releases link not found"
    assert "https://github.com/user/muxterm/releases" in section, (
        "GitHub Releases URL not found"
    )


def test_user_placeholder_note():
    content = read_readme()
    install_end = content.index(WHAT_HEADING)
    install_start = content.index(INSTALL_HEADING)
    section = content[install_start:install_end]
    assert "Replace `user`" in section, "Placeholder note about 'user' not found"


def test_existing_content_unchanged():
    """Verify ## What is this? and its content are unchanged."""
    content = read_readme()
    assert "muxterm is a terminal multiplexer where the UI lives in a browser." in content
    assert "sessiond (PTY daemon)" in content
    assert "No tmux required." in content


def run_all():
    tests = [
        test_install_heading_exists,
        test_install_after_tagline,
        test_what_is_this_after_install,
        test_install_immediately_after_tagline,
        test_homebrew_subsection,
        test_curl_subsection,
        test_go_install_subsection,
        test_windows_scoop_subsection,
        test_github_releases_link,
        test_user_placeholder_note,
        test_existing_content_unchanged,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed}/{passed + failed} tests passed")
    return failed == 0


if __name__ == "__main__":
    ok = run_all()
    sys.exit(0 if ok else 1)
