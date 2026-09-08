#!/usr/bin/env python3
"""A resumed goal lane must keep the verdict and the identity of the run it resumes.

A goal lane no longer dies when its loop ends: the pane resumes that same
session interactively (internal/sessiond/goallane.go). The resumed process is a
NEW process with a NEW SessionRecord, so without SessionRecord._adopt_prior_ending
it publishes `interactive/working` -- a lane that has finished its goal reporting
that it is still working, indistinguishable from an interactive lane that never
had a goal. Those are the two readings the mode distinction exists to prevent.

This is where the adoption is proven. It cannot be proven end-to-end on a branch:
behaviors/muxterm.yaml sources this module from git@main, and a bundle prepared
from that cache does not re-resolve to a working tree, so the live lane runs
whatever hook main is publishing -- verified with a probe that never fired. The
rules below are the whole of the decision, so testing them directly is testing it.

state.py is loaded by path rather than imported as a package: the package
__init__ pulls in amplifier_core, which the repo's test run has no reason to
have installed. state.py itself imports nothing outside the standard library,
which is what makes that possible.
"""

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

STATE_PY = (
    Path(__file__).parent.parent
    / "modules"
    / "hooks-muxterm-session"
    / "amplifier_module_hooks_muxterm_session"
    / "state.py"
)


def _load_state_module():
    spec = importlib.util.spec_from_file_location("_muxterm_hook_state", STATE_PY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state = _load_state_module()


def _record_over(prior: dict | None):
    """Build a SessionRecord whose spool already holds `prior` for the same id."""
    spool = Path(tempfile.mkdtemp())
    session_id = "11111111-2222-3333-4444-555555555555"
    if prior is not None:
        (spool / f"{session_id}.json").write_text(json.dumps(prior), encoding="utf-8")
    return state.SessionRecord(session_id, spool)


def _prior(**overrides):
    base = {
        "v": 1,
        "pid": 4242,
        "pidStart": 1,
        "sessionId": "11111111-2222-3333-4444-555555555555",
        "harness": "amplifier",
        "name": "ship the release notes",
        "label": "release notes",
        "mode": "autonomous",
        "state": "done",
        "updatedAt": 1,
        "sid": 4243,
        "doneMeans": "the release notes are published",
    }
    base.update(overrides)
    return base


def test_finished_goal_run_is_adopted():
    """The whole point: the row still reads as the goal lane it was."""
    record = _record_over(_prior())
    assert record.mode == state.MODE_AUTONOMOUS
    assert record.state == state.STATE_DONE
    assert record.done_means == "the release notes are published"
    assert record.goal_finished is True


def test_failed_goal_run_keeps_its_failure():
    """A failed run is the one this must never round up."""
    record = _record_over(_prior(state="failed"))
    assert record.state == state.STATE_FAILED
    assert record.mode == state.MODE_AUTONOMOUS


def test_capped_out_goal_run_keeps_stopped():
    """`stopped` means the loop stopped SHORT of the condition. Not done."""
    record = _record_over(_prior(state="stopped"))
    assert record.state == state.STATE_STOPPED
    assert record.mode == state.MODE_AUTONOMOUS


def test_name_and_label_carry_so_the_lane_does_not_appear_to_change_identity():
    record = _record_over(_prior())
    assert record.name == "ship the release notes"
    assert record.label == "release notes"


def test_interactive_ending_is_not_adopted():
    """An ordinary chat session that ended is not a goal lane, and pinning a
    stop condition onto one asserts a goal nobody agreed to."""
    record = _record_over(_prior(mode="interactive"))
    assert record.mode == state.MODE_INTERACTIVE
    assert record.done_means == ""
    assert record.goal_finished is False


def test_running_goal_is_not_adopted():
    """Only an ENDED run is adopted. A row still claiming to work belongs to a
    process that may still be alive; inheriting it would clone a live lane."""
    record = _record_over(_prior(state="working"))
    assert record.mode == state.MODE_INTERACTIVE
    assert record.state == state.STATE_WORKING
    assert record.goal_finished is False


def test_no_prior_snapshot_starts_fresh():
    record = _record_over(None)
    assert record.mode == state.MODE_INTERACTIVE
    assert record.state == state.STATE_WORKING
    assert record.done_means == ""
    assert record.goal_finished is False


def test_unreadable_prior_snapshot_starts_fresh():
    """Adoption is best-effort by construction: a corrupt spool file must cost a
    plain row, never a session."""
    spool = Path(tempfile.mkdtemp())
    session_id = "11111111-2222-3333-4444-555555555555"
    (spool / f"{session_id}.json").write_text("{not json", encoding="utf-8")
    record = state.SessionRecord(session_id, spool)
    assert record.mode == state.MODE_INTERACTIVE
    assert record.goal_finished is False


def test_adopted_verdict_survives_session_end_without_promotion():
    """on_session_end promotes working/blocked to done on the way out, and
    deliberately does NOT promote a finished goal lane's `stopped`. An adopted
    record has to be on the right side of that rule, or a capped-out run that
    the human never touched would be written down as `done` when they close the
    pane -- the one direction this view must never fail in."""
    record = _record_over(_prior(state="stopped"))
    promote_from = (state.STATE_WORKING, state.STATE_BLOCKED, state.STATE_STOPPED)
    if record.mode == state.MODE_AUTONOMOUS and record.goal_finished:
        promote_from = (state.STATE_WORKING, state.STATE_BLOCKED)
    assert record.state not in promote_from


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
    sys.exit(1 if failures else 0)
