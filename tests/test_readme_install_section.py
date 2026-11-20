#!/usr/bin/env python3
"""Check the README's public install and first-use information."""

import sys
from pathlib import Path

README = Path(__file__).parent.parent / "README.md"
INSTALL_GUIDE = Path(__file__).parent.parent / "docs/guides/installation-and-updates.md"
REMOTE_GUIDE = Path(__file__).parent.parent / "docs/guides/remote-projects-and-chats.md"
AGENT_GUIDE = Path(__file__).parent.parent / "docs/guides/agent-integration.md"


def read_readme():
    return README.read_text(encoding="utf-8")


def test_get_started_follows_value_proposition():
    content = read_readme()
    assert "## Get started" in content
    assert content.index("## Get started") > content.index("**Use the harnesses and subscriptions")


def test_supported_install_commands():
    content = read_readme()
    section = content.split("## Get started", 1)[1].split("## A good first workflow", 1)[0]
    assert "brew install kenotron-ms/tap/muxterm" in section
    assert "curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh | bash" in section
    assert "https://github.com/kenotron-ms/muxterm/releases/latest" in section


def test_harness_setup_and_workflow():
    content = read_readme()
    assert "codex login" in content
    assert "amplifier init" in content
    assert "**File a Work item for an outcome.**" in content
    assert "**Pick up from another screen.**" in content


def test_detailed_guides_exist():
    content = read_readme()
    for path in (INSTALL_GUIDE, REMOTE_GUIDE, AGENT_GUIDE):
        assert path.exists(), f"missing guide: {path}"
        assert str(path.relative_to(README.parent)) in content


def run_all():
    checks = (
        test_get_started_follows_value_proposition,
        test_supported_install_commands,
        test_harness_setup_and_workflow,
        test_detailed_guides_exist,
    )
    failed = 0
    for check in checks:
        try:
            check()
            print(f"  PASS  {check.__name__}")
        except AssertionError as error:
            print(f"  FAIL  {check.__name__}: {error}")
            failed += 1
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed")
    return failed == 0


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)
