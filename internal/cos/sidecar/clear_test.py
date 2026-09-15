#!/usr/bin/env python3
"""What `clear` must do to the LIVE chief-of-staff session, not just to a view.

THE BUG THIS FILE EXISTS TO CATCH.  A "clear" that empties the browser and
leaves the agent's context intact is the worst possible outcome: the human
sees a clean slate, the agent does not have one, and every decision the human
makes afterwards is made against a display that disagrees with reality.
_handle_clear already avoids that -- it replaces the live context and refuses
rather than lie when it cannot -- but nothing anywhere in this repository
proved it, so nothing stopped a later refactor from quietly turning the prune
into a view reset.  These tests are that proof.

The five properties locked in here, and where each one comes from:

  1. THE LIVE CONTEXT IS REPLACED.  main.py:_set_context_messages calls
     context.set_messages(kept), the same call build() makes at boot.  Without
     it the next turn's _save_session() writes the untouched in-memory
     transcript back over the pruned file and everything returns.
  2. A CLEAR THAT CANNOT DO (1) IS REFUSED, and refused BEFORE anything is
     written.  A session whose context module has no set_messages is left
     exactly as it was, with an error the browser shows.
  3. MID-TURN IS REFUSED, visibly, writing nothing.
  4. A MESSAGE NAMING A STILL-LIVE LANE SURVIVES.  The roster is the
     session-state directory muxterm writes one JSON file per live agent
     session into.
  5. THE PRE-CLEAR TRANSCRIPT SURVIVES ON DISK as a timestamped backup.  The
     button prunes; it never destroys the only copy.

HOW THIS RUNS.  main.py imports only the standard library at module scope, so
it can be imported directly; its amplifier imports are all inside the
functions that use them.  Import has one side effect -- the stdout discipline
in its header dups fd 2 over fd 1 -- which _import_sidecar undoes.

The amplifier session store is used FOR REAL when amplifier is installed (the
sidecar cannot run without it) and otherwise replaced with a small stand-in
whose signatures are copied from amplifier_foundation/session/store.py:

    TRANSCRIPT_FILENAME = "transcript.jsonl"
    def load_transcript(session_dir: Path) -> list[dict]
    def write_transcript(session_dir: Path, entries: list[dict]) -> None
    def backup(filepath: Path, label: str) -> Path | None   # <name>.bak-<label>-<ts>

Run it directly (python3 clear_test.py) or through `go test ./internal/cos/`,
which shells out to this file so one `make test` covers it.
"""

import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

SIDECAR_MAIN = Path(__file__).resolve().parent / "main.py"


# --- importing the sidecar --------------------------------------------------
def _import_sidecar():
    """Import main.py as a module, undoing its stdout redirection afterwards.

    main.py's header keeps the real stdout as a private fd and points fd 1 at
    stderr so stray prints from the amplifier stack cannot corrupt the NDJSON
    protocol stream.  That is right for the sidecar and wrong for a test
    runner, whose report goes to stdout, so both fd 1 and sys.stdout are put
    back the way they were.
    """
    saved_fd = os.dup(1)
    saved_stdout = sys.stdout
    spec = importlib.util.spec_from_file_location("cos_sidecar_main", SIDECAR_MAIN)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec: @dataclass resolves its own module out of
    # sys.modules and raises if it is not there.
    sys.modules["cos_sidecar_main"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        os.dup2(saved_fd, 1)
        os.close(saved_fd)
        sys.stdout = saved_stdout
    return module


main = _import_sidecar()


# --- the session store ------------------------------------------------------
def _install_store_stub():
    """Provide amplifier_foundation.session.store when amplifier is absent.

    Returns True when the real package is being used.  The stand-in mirrors
    the real signatures (quoted in this module's docstring); the sidecar only
    ever asks it for these four names.
    """
    try:
        import amplifier_foundation.session.store  # noqa: F401

        return True
    except Exception:
        pass

    store = types.ModuleType("amplifier_foundation.session.store")
    store.TRANSCRIPT_FILENAME = "transcript.jsonl"

    def load_transcript(session_dir):
        path = Path(session_dir) / store.TRANSCRIPT_FILENAME
        if not path.exists():
            return []
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out

    def write_transcript(session_dir, entries):
        path = Path(session_dir) / store.TRANSCRIPT_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries),
            encoding="utf-8",
        )

    def backup(filepath, label):
        filepath = Path(filepath)
        if not filepath.exists():
            return None
        stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d%H%M%S")
        dest = filepath.parent / f"{filepath.name}.bak-{label}-{stamp}"
        shutil.copy2(filepath, dest)
        return dest

    store.load_transcript = load_transcript
    store.write_transcript = write_transcript
    store.backup = backup

    session = types.ModuleType("amplifier_foundation.session")
    session.store = store
    # diagnose/repair are optional to the clear path -- it wraps them in its
    # own try -- but a stand-in that reports "healthy" keeps the test on the
    # same branch the real one takes for a well-formed transcript.
    session.diagnose_transcript = lambda msgs: {"status": "healthy"}
    session.repair_transcript = lambda msgs, diagnosis: msgs

    root = types.ModuleType("amplifier_foundation")
    root.session = session

    sys.modules.setdefault("amplifier_foundation", root)
    sys.modules["amplifier_foundation.session"] = session
    sys.modules["amplifier_foundation.session.store"] = store
    return False


USING_REAL_STORE = _install_store_stub()


# --- doubles ----------------------------------------------------------------
class RecordingProto:
    """Captures what the sidecar would have written to the host."""

    def __init__(self):
        self.events = []

    def emit(self, **event):
        self.events.append(event)

    def of(self, ev):
        return [e for e in self.events if e.get("ev") == ev]


class FakeContext:
    """A context module that can be replaced, like the real one.

    set_messages is the single call that decides whether a clear is real: it
    is what boot uses to load a transcript into the live session, so it is
    what a prune has to use to unload one.
    """

    def __init__(self, messages=None):
        self.messages = list(messages or [])
        self.set_calls = []

    async def set_messages(self, messages):
        self.set_calls.append(list(messages))
        self.messages = list(messages)


class BlindContext:
    """A context module with no set_messages: nothing here can forget."""

    def __init__(self, messages=None):
        self.messages = list(messages or [])


class FakeCoordinator:
    def __init__(self, context):
        self._context = context

    def get(self, name):
        return self._context if name == "context" else None


class FakeSession:
    def __init__(self, context):
        self.coordinator = FakeCoordinator(context)


class FakeStore:
    def __init__(self, base_dir):
        self.base_dir = str(base_dir)


def stamp(offset_seconds=0):
    """An ISO-8601 message timestamp, offset from now."""
    return datetime.fromtimestamp(time.time() + offset_seconds, tz=timezone.utc).isoformat()


def user_msg(text, offset_seconds=0):
    return {"role": "user", "content": text, "metadata": {"timestamp": stamp(offset_seconds)}}


def assistant_msg(text, offset_seconds=0):
    return {"role": "assistant", "content": text, "metadata": {"timestamp": stamp(offset_seconds)}}


class ClearCase(unittest.TestCase):
    """One sidecar, one temp session dir, one temp lane roster per test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)

        # The lane roster is a directory of JSON files under XDG_RUNTIME_DIR;
        # pointing that at a temp dir keeps the test off the real one, so it
        # can neither read this machine's live lanes nor write to them.
        self.runtime = root / "run"
        self.roster = self.runtime.joinpath(*main.SESSION_STATE_REL)
        self.roster.mkdir(parents=True)
        self._old_xdg = os.environ.get("XDG_RUNTIME_DIR")
        os.environ["XDG_RUNTIME_DIR"] = str(self.runtime)
        self.addCleanup(self._restore_xdg)

        self.session_id = "muxterm-cos"
        self.sessions_dir = root / "sessions"
        self.session_dir = self.sessions_dir / self.session_id
        self.session_dir.mkdir(parents=True)

        self.proto = RecordingProto()
        self.context = FakeContext()
        # Built without __init__ on purpose: __init__ wires an approval broker,
        # a display and an argparse namespace, none of which the clear path
        # touches.  The METHOD under test is the real one.
        self.sidecar = object.__new__(main.Sidecar)
        self.sidecar.proto = self.proto
        self.sidecar.session_id = self.session_id
        self.sidecar.session = FakeSession(self.context)
        self.sidecar.store = FakeStore(self.sessions_dir)
        self.sidecar._turn = None

    def _restore_xdg(self):
        if self._old_xdg is None:
            os.environ.pop("XDG_RUNTIME_DIR", None)
        else:
            os.environ["XDG_RUNTIME_DIR"] = self._old_xdg

    # -- helpers -------------------------------------------------------------
    def write_transcript(self, messages):
        path = self.session_dir / "transcript.jsonl"
        path.write_text(
            "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages),
            encoding="utf-8",
        )
        return path

    def read_transcript(self):
        path = self.session_dir / "transcript.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def add_live_lane(self, session_id):
        """Register a lane in the roster, the way muxterm's hook does."""
        (self.roster / f"{session_id}.json").write_text(
            json.dumps({"sessionId": session_id, "state": "working"}),
            encoding="utf-8",
        )

    def clear(self, older_than_days=0, req_id="r-1"):
        asyncio.run(
            self.sidecar._handle_clear({"op": "clear", "older_than_days": older_than_days, "req_id": req_id})
        )

    def backups(self):
        return sorted(self.session_dir.glob("transcript.jsonl.bak-cos-clear-*"))

    # -- 1. the crux ---------------------------------------------------------
    def test_clear_all_replaces_the_live_context(self):
        """The agent must forget, not just the browser.

        This is the whole bug: an empty view over a full context. The prune
        reaching disk is not enough -- set_messages is what makes the NEXT
        turn start from nothing, and _save_session at the end of that turn is
        what would otherwise write the old conversation straight back.
        """
        messages = [
            user_msg("the deploy key is in vault path kv/prod"),
            assistant_msg("noted"),
            user_msg("and the rollback runbook is at docs/rollback.md"),
            assistant_msg("noted"),
        ]
        self.write_transcript(messages)
        self.context.messages = list(messages)

        self.clear()

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1, f"expected one cleared event, got {self.proto.events}")
        self.assertTrue(cleared[0]["reloaded"], "clear reported success without reloading the live context")
        self.assertEqual(cleared[0]["removed"], 4)
        self.assertEqual(cleared[0]["kept"], 0)
        self.assertEqual(cleared[0]["req_id"], "r-1", "the reply must carry the req_id the caller is waiting on")

        # The live session was actually emptied...
        self.assertEqual(self.context.set_calls, [[]], "the live context was never replaced")
        self.assertEqual(self.context.messages, [])
        # ...and so was the file the next boot would read back.
        self.assertEqual(self.read_transcript(), [])

        # Nothing that could answer "what was the vault path?" survives in
        # either place, which is the test the human actually runs.
        blob = json.dumps(self.context.messages) + json.dumps(self.read_transcript())
        self.assertNotIn("kv/prod", blob)
        self.assertNotIn("rollback.md", blob)

    def test_clear_empties_memory_even_with_nothing_on_disk(self):
        """A session that has taken turns but never been saved still forgets."""
        self.context.messages = [user_msg("unsaved but very much remembered")]

        self.clear()

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1, f"expected one cleared event, got {self.proto.events}")
        self.assertTrue(cleared[0]["reloaded"])
        self.assertEqual(self.context.set_calls, [[]])

    # -- 2. no false success -------------------------------------------------
    def test_clear_refuses_when_the_live_context_cannot_be_replaced(self):
        """No set_messages means no clear -- and no write, and no lie.

        This is the exact shape of the reported bug, and the sidecar's answer
        is to refuse: a prune that reaches only the disk is undone by the next
        turn's save, so the transcript is left untouched and the browser is
        told why. cos-clear-result then carries ok:false, and the view keeps
        the conversation the agent still has.
        """
        messages = [user_msg("remember this"), assistant_msg("remembered")]
        self.write_transcript(messages)
        self.sidecar.session = FakeSession(BlindContext(messages))

        self.clear()

        self.assertEqual(self.proto.of("cleared"), [], "reported a clear it could not perform")
        errors = self.proto.of("error")
        self.assertEqual(len(errors), 1, f"expected one error, got {self.proto.events}")
        self.assertEqual(errors[0]["code"], "clear_unsupported")
        self.assertEqual(errors[0]["req_id"], "r-1")
        self.assertFalse(errors[0]["fatal"], "a refused clear is not a fatal session error")
        # Refused BEFORE anything was written: same transcript, no backup.
        self.assertEqual(self.read_transcript(), messages)
        self.assertEqual(self.backups(), [], "wrote a backup for a clear it then refused")

    # -- 3. mid-turn ---------------------------------------------------------
    def test_clear_mid_turn_is_refused_visibly_and_writes_nothing(self):
        """Clear arriving while the chief of staff is working: reject, loudly.

        The turn is appending to this transcript and will save it again at
        turn end, so a prune now is both a data race and a prune that undoes
        itself. The answer is an error the browser renders as a notice, with
        the transcript, the live context and the running turn all untouched.
        """
        messages = [user_msg("first"), assistant_msg("second")]
        self.write_transcript(messages)
        self.context.messages = list(messages)

        turn = types.SimpleNamespace(id="t-42")
        self.sidecar._turn = turn

        self.clear()

        self.assertEqual(self.proto.of("cleared"), [], "cleared during a live turn")
        errors = self.proto.of("error")
        self.assertEqual(len(errors), 1, f"expected one error, got {self.proto.events}")
        self.assertEqual(errors[0]["code"], "clear_failed")
        self.assertIn("t-42", errors[0]["message"], "the refusal must name the turn that blocked it")
        self.assertEqual(errors[0]["req_id"], "r-1", "a refusal must answer the waiting caller")
        self.assertFalse(errors[0]["fatal"])

        # Nothing moved: not the file, not the backup, not the live context...
        self.assertEqual(self.read_transcript(), messages)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.context.set_calls, [])
        self.assertEqual(self.context.messages, messages)
        # ...and not the turn, which is still the sidecar's active one.
        self.assertIs(self.sidecar._turn, turn, "a refused clear must not disturb the running turn")

    def test_clear_after_the_turn_ends_succeeds(self):
        """The refusal is about timing, not about a session that can never clear."""
        self.write_transcript([user_msg("first"), assistant_msg("second")])
        self.sidecar._turn = types.SimpleNamespace(id="t-42")
        self.clear(req_id="r-1")
        self.assertEqual(self.proto.of("cleared"), [])

        self.sidecar._turn = None
        self.clear(req_id="r-2")

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1)
        self.assertEqual(cleared[0]["req_id"], "r-2")
        self.assertEqual(self.context.set_calls, [[]])

    # -- 4. live lanes -------------------------------------------------------
    def test_clear_keeps_messages_that_name_a_still_live_lane(self):
        """A running lane's context is not collateral damage.

        The chief of staff spawns lanes that run for many minutes in other
        workspaces. Clearing the CONVERSATION must not leave it unable to talk
        about work that is still in flight, so any turn mentioning a session
        in the live roster is kept -- and the browser is told, because a
        "clear everything" that keeps things has to say so.
        """
        lane = "9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a"
        self.add_live_lane(lane)

        keep_prompt = f"how is lane {lane} getting on?"
        messages = [
            user_msg("something unrelated"),
            assistant_msg("fine"),
            user_msg(keep_prompt),
            assistant_msg("still running"),
        ]
        self.write_transcript(messages)
        self.context.messages = list(messages)

        self.clear()

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1, f"expected one cleared event, got {self.proto.events}")
        self.assertEqual(cleared[0]["kept"], 2, "the live lane's turn was dropped")
        self.assertEqual(cleared[0]["removed"], 2)
        self.assertEqual(len(cleared[0]["protected"]), 1)
        # The reported lane is the NEEDLE that matched, which for a uuid-shaped
        # session id may be its eight-character prefix: _lane_needles adds both
        # forms so a message naming a lane in short form is protected too.
        self.assertTrue(
            lane.startswith(cleared[0]["protected"][0]["lane"]),
            f"protected lane {cleared[0]['protected'][0]['lane']!r} does not identify {lane!r}",
        )
        self.assertIn(keep_prompt[:20], cleared[0]["protected"][0]["prompt"])

        surviving = self.read_transcript()
        self.assertEqual([m["content"] for m in surviving], [keep_prompt, "still running"])
        # Disk and live context agree -- the property the whole feature is for.
        self.assertEqual(self.context.set_calls, [surviving])
        self.assertEqual(self.context.messages, surviving)

    def test_clear_does_not_disturb_the_lane_roster(self):
        """Clearing a conversation stops no lane.

        The roster IS muxterm's record of which agent sessions are alive, so a
        clear that removed or rewrote an entry would be a clear that orphaned
        a lane. It is read, never written.
        """
        lanes = {
            "9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a": None,
            "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d": None,
        }
        for lane in lanes:
            self.add_live_lane(lane)
            path = self.roster / f"{lane}.json"
            lanes[lane] = (path.read_bytes(), path.stat().st_mtime_ns)

        self.write_transcript([user_msg("nothing about any lane"), assistant_msg("ok")])
        self.clear()

        self.assertEqual(len(self.proto.of("cleared")), 1)
        for lane, (content, mtime) in lanes.items():
            path = self.roster / f"{lane}.json"
            self.assertTrue(path.exists(), f"clear removed live lane {lane} from the roster")
            self.assertEqual(path.read_bytes(), content, f"clear rewrote live lane {lane}")
            self.assertEqual(path.stat().st_mtime_ns, mtime, f"clear touched live lane {lane}")
        self.assertEqual(
            sorted(p.name for p in self.roster.glob("*.json")),
            sorted(f"{lane}.json" for lane in lanes),
            "the roster gained or lost entries during a clear",
        )

    def test_the_cos_own_session_does_not_protect_itself(self):
        """Self-protection would be a clear that never clears.

        The sidecar registers its own amplifier session in the same roster, so
        without the exclusion every message naming the session the transcript
        BELONGS TO would survive forever.
        """
        self.add_live_lane(self.session_id)
        self.write_transcript([user_msg(f"this is session {self.session_id}"), assistant_msg("indeed")])

        self.clear()

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1)
        self.assertEqual(cleared[0]["removed"], 2, "the chief of staff protected itself from its own clear")
        self.assertEqual(cleared[0]["protected"], [])

    # -- 5. history is pruned, never destroyed -------------------------------
    def test_the_pre_clear_transcript_is_preserved_on_disk(self):
        """Clear detaches the conversation; it does not destroy it.

        A UI button that irrecoverably deletes history is a sharp edge, so the
        pre-clear file is copied to a timestamped bak-cos-clear-* alongside it
        BEFORE the prune, and that copy is never removed.
        """
        messages = [user_msg("the deploy key is in vault path kv/prod"), assistant_msg("noted")]
        self.write_transcript(messages)

        self.clear()

        backups = self.backups()
        self.assertEqual(len(backups), 1, f"expected exactly one backup, found {backups}")
        preserved = [json.loads(line) for line in backups[0].read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(preserved, messages, "the backup is not a faithful copy of the pre-clear transcript")
        # The live transcript is empty; the history is recoverable by hand.
        self.assertEqual(self.read_transcript(), [])

    def test_the_recovery_copy_cannot_resurrect_cleared_messages(self):
        """transcript.jsonl.backup is pruned too.

        The session store falls back to that file when the main one will not
        parse, so leaving a full copy there would let a corrupt write bring
        back exactly what the human asked to forget -- while the timestamped
        bak-cos-clear-* copy keeps it recoverable on purpose.
        """
        messages = [user_msg("secret sauce"), assistant_msg("noted")]
        self.write_transcript(messages)
        recovery = self.session_dir / "transcript.jsonl.backup"
        recovery.write_text(
            "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages),
            encoding="utf-8",
        )

        self.clear()

        self.assertEqual(recovery.read_text(encoding="utf-8").strip(), "")
        self.assertEqual(len(self.backups()), 1)

    # -- the day cut-off -----------------------------------------------------
    def test_clear_older_than_days_keeps_recent_turns(self):
        """The 7/30-day menu items prune by age, and memory follows disk."""
        old = [user_msg("ancient", offset_seconds=-40 * 86400), assistant_msg("ok", offset_seconds=-40 * 86400)]
        new = [user_msg("today", offset_seconds=-60), assistant_msg("ok", offset_seconds=-60)]
        self.write_transcript(old + new)

        self.clear(older_than_days=30)

        cleared = self.proto.of("cleared")
        self.assertEqual(len(cleared), 1, f"expected one cleared event, got {self.proto.events}")
        self.assertEqual(cleared[0]["removed"], 2)
        self.assertEqual(cleared[0]["kept"], 2)
        surviving = self.read_transcript()
        self.assertEqual([m["content"] for m in surviving], ["today", "ok"])
        self.assertEqual(self.context.set_calls, [surviving], "memory kept a different set from disk")

    def test_a_negative_cut_off_is_refused_without_touching_anything(self):
        messages = [user_msg("keep me"), assistant_msg("ok")]
        self.write_transcript(messages)

        asyncio.run(self.sidecar._handle_clear({"op": "clear", "older_than_days": -1, "req_id": "r-1"}))

        self.assertEqual(self.proto.of("cleared"), [])
        errors = self.proto.of("error")
        self.assertEqual(len(errors), 1, f"expected one error, got {self.proto.events}")
        self.assertEqual(errors[0]["req_id"], "r-1")
        self.assertEqual(self.read_transcript(), messages)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.context.set_calls, [])


if __name__ == "__main__":
    print(
        f"amplifier session store: {'real' if USING_REAL_STORE else 'stand-in'}",
        file=sys.stderr,
    )
    unittest.main(verbosity=2)
