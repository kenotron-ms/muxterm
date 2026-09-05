"""End-of-turn intent classification.

The problem this solves
----------------------

``prompt:complete`` tells the hook one thing with total certainty: the CLI is
back at its input prompt. It says nothing about *why*. These two turns end
identically as far as the kernel is concerned::

    "Done -- the migration is applied and the tests pass."
    "Do you want me to apply the migration, or dry-run it first?"

The first is finished work. The second is a question with nobody listening.
Structurally they are the same event, so the pre-existing behaviour -- mark the
session ``stopped`` and move on -- is right for one and silently wrong for the
other. A session that asked you something and then fell off the home view is
the single most expensive failure this view can have.

So: read the assistant's own final text and ask a cheap model which one it was.

Why the coordinator, not an HTTP endpoint
-----------------------------------------

This module is mounted *inside* a live Amplifier session, and that session
already has a configured, authenticated provider. ``coordinator.get("providers")``
reaches it directly. The alternative -- posting to a local chat-completions
server -- would work on a machine that happens to run one and silently do
nothing everywhere else, which is the worst failure shape available: invisible,
and only on other people's machines.

Going through the coordinator also means the classification uses whatever
provider the user configured, so it cannot drift from the session it describes.

Failure direction
-----------------

Every failure path returns ``None``, which the caller reads as "keep the
structural verdict". That direction is deliberate and matches the rule stated
in ``muxterm session report``'s own help text: a false alarm teaches people to
ignore the indicator, which costs more than a missed one. An unreachable
provider, a timeout, a malformed answer, an unparseable payload -- all of them
leave the session exactly as ``prompt:complete`` found it.

The one failure that is *not* simply absorbed is a rejected ``classify_model``
override, because that one is permanent rather than transient: a model id the
user's provider does not accept would turn this whole path off forever, for
them alone, without a word. See ``_complete_with_model_fallback`` -- it is
spent once more without the override, and only then returns ``None``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Bound on the classifier call. This runs at the moment the human gets their
# prompt back, so it is latency-sensitive by construction -- but the caller
# has already flushed the structural verdict before we are invoked, so
# overrunning costs a late row update, never a stalled session.
CLASSIFY_TIMEOUT_S = 12.0

# Every finished turn is classified -- there is no cheap pre-filter any more.
#
# There used to be one: a turn with no question mark and no interrogative
# phrase short-circuited to "not blocked" without spending a call. That was
# sound while the only question was "is this waiting on a human?". It stopped
# being sound the moment a finished row also needed a summary, because the
# turns it skipped were exactly the finished ones -- so completed rows silently
# kept whatever `doing` line the last tool call happened to leave behind, and
# the summary never ran at all. Observed as a row reading
# "bash: find ... -name '*.go' | wc -l" instead of the answer that session
# produced.
#
# The call is cheap and bounded. Set `classify_end_of_turn: false` to opt out
# entirely; there is no half-measure that keeps summaries and skips the call.

# The assistant text is clipped before it is sent. A turn's final message is
# usually short; the pathological case is a multi-thousand-line dump, and the
# question -- if there is one -- is almost always at the end. So keep the TAIL,
# not the head.
MAX_RESPONSE_CHARS = 4000

# Upper bound on the summarised ask. It has to fit one row of the home view.
MAX_ASK_CHARS = 120

_SCHEMA: dict[str, Any] = {
    "name": "turn_intent",
    "schema": {
        "type": "object",
        "properties": {
            "needs_input": {
                "type": "boolean",
                "description": (
                    "true only if the assistant is waiting on the human for "
                    "something it cannot decide or discover by itself"
                ),
            },
            "summary": {
                "type": "string",
                "description": (
                    "one short line. If needs_input, the thing the human must "
                    "supply. Otherwise, what the session actually accomplished."
                ),
            },
        },
        "required": ["needs_input", "summary"],
        "additionalProperties": False,
    },
    "strict": True,
}

_SYSTEM = """You classify the final message of an AI coding assistant's turn.

Answer one question: is the assistant WAITING ON THE HUMAN?

needs_input = true when the assistant cannot continue without a human:
  - it asks the human to choose between options
  - it asks for a credential, a path, a name, a decision only the human owns
  - it reports it is blocked and names what it needs
  - it asks for permission to do something consequential

needs_input = false when:
  - the work is finished and it is reporting the result
  - it failed and is reporting the failure without asking anything
  - it asks a rhetorical or courtesy question ("want me to keep going?",
    "anything else?", "let me know if you want changes") -- these are offers,
    not blockers, and the work already stands complete
  - it merely describes what it did or will do next

The courtesy case is the one that matters most. An assistant that finished its
work and politely offers more is NOT blocked. Only mark needs_input when the
work genuinely cannot proceed until the human supplies something.

If it is ambiguous, answer false.

ALWAYS write a summary, on both branches. It is the single line a human reads
on a dashboard row instead of opening the session, so it has to carry the
substance:

  - needs_input true  -> what the human must supply.
      good: "pick wrap vs replace for sessiond.Client"
      bad:  "waiting for input"        (says nothing they did not know)

  - needs_input false -> what the session actually accomplished or how it
    ended. Name the thing, not the activity.
      good: "added pane send + workspace verbs, go build clean"
      good: "failed: the 250ms preview gate assumption was wrong"
      bad:  "task completed"           (true of every finished row)

No trailing period. Aim for under 90 characters.

Reply with ONLY this JSON object -- no other keys, no prose, no code fence:

  {"needs_input": true, "summary": "one short line"}

The key must be spelled "summary". A model given an earlier version of this
task returned {"needs_input": true, "confidence": "high", "reason": "..."}
instead, which answers the question correctly and drops the line the row
needs."""


def _ask_from_text(text: str) -> str:
    """Recover the ask from the assistant's own words.

    The classifier is asked for a one-line summary, but ``response_format`` is
    advisory on some providers: a model that ignores the schema still answers
    the boolean correctly while dropping the summary. Observed in practice --
    the answer came back as ``{"needs_input": true, "confidence": "high",
    "reason": "..."}``, correct and unusable.

    The question is already in the text we just classified, so take it from
    there rather than publishing a blocked row with nothing written on it.

    The LAST question wins, not the first: a turn that reasons out loud before
    asking ends on the thing it actually wants.
    """
    best = ""
    for chunk in text.replace("\n", " ").split("?"):
        candidate = chunk.strip()
        if not candidate:
            continue
        for sep in (". ", "! ", "  "):
            if sep in candidate:
                candidate = candidate.rsplit(sep, 1)[-1].strip()
        if candidate:
            best = candidate + "?"
    return best


def _response_text(response: Any) -> str:
    """Pull plain text out of a ChatResponse without assuming its shape.

    ``ChatResponse.content`` is a list of content blocks in the normal case,
    but a provider is free to hand back a bare string. Both are accepted; an
    unrecognised shape yields "" and the caller degrades.
    """
    content = getattr(response, "content", None)
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "".join(parts)


def _pick_provider(coordinator: Any) -> Any | None:
    """Return a mounted provider, or None.

    ``providers`` is a multi-slot mount point, so ``get`` without a name hands
    back the whole dict. Any of them can answer this question -- the classifier
    is not picky, and a session always has at least one mounted or it could not
    have produced the turn being classified.
    """
    try:
        mounted = coordinator.get("providers")
    except Exception:
        return None
    if isinstance(mounted, dict):
        for provider in mounted.values():
            if provider is not None:
                return provider
        return None
    return mounted or None


async def _complete_with_model_fallback(
    provider: Any,
    request_cls: Any,
    request_kwargs: dict[str, Any],
    *,
    model: str | None,
    timeout_s: float,
    what: str,
) -> Any | None:
    """Run one provider call, dropping a rejected model override and retrying.

    Shared by this module and ``label.py``, for the reason those two already
    share ``_pick_provider`` and ``_response_text``: two copies of a retry rule
    become two different retry rules, and the divergence shows up as one of the
    two calls quietly behaving differently from the other.

    Why the retry exists
    --------------------

    ``classify_model`` / ``label_model`` let these calls be pointed at a cheap
    model instead of the session's own. The id is a plain string against
    whatever provider the user happens to have mounted, so it can simply be
    wrong -- an Anthropic id on an OpenAI provider, a model retired last month,
    a typo. The provider rejects it, and without this retry every failure path
    already leads to ``None``, so the feature would be *permanently* and
    *silently* off for exactly the users whose provider disagreed with a
    default written by somebody else. That is the failure shape this module's
    own docstring rejects: invisible, and only on other people's machines.

    So a rejected override is spent once more without the override, which lands
    on the provider's own default model. The feature degrades to costing more
    than intended, never to doing nothing.

    Why a timeout does NOT trigger the fallback
    -------------------------------------------

    A timeout is not evidence the model id was wrong. A provider that does not
    recognise a model id says so promptly; a timeout means the call was
    accepted and is simply slow, which is transient and says nothing about the
    override. Retrying it would buy no new information and spend a second full
    ``timeout_s`` budget at the worst possible moment -- the classifier runs as
    the human gets their prompt back, the labeller runs in front of the turn
    starting -- and it would do that for every user who ever times out, not
    just for the misconfigured ones. Timeouts therefore keep today's behaviour
    exactly: one attempt, then ``None``.

    Returns the provider's response, or ``None``. Both attempts are bounded
    individually by ``timeout_s``; ``model`` of ``None`` means no override was
    in play, and then there is nothing to fall back from, so a failure is a
    single attempt exactly as before.
    """

    async def attempt(use_model: str | None) -> Any:
        # The override is applied here rather than by the caller so the retry
        # is structurally incapable of carrying it: `request_kwargs` never
        # holds a "model" key, so the second call cannot inherit the first
        # call's mistake.
        kwargs = dict(request_kwargs)
        if use_model:
            kwargs["model"] = use_model
        return await asyncio.wait_for(
            provider.complete(request_cls(**kwargs)), timeout=timeout_s
        )

    try:
        return await attempt(model)
    except asyncio.TimeoutError:
        logger.debug("muxterm %s: timed out after %.0fs", what, timeout_s)
        return None
    except Exception as exc:
        if not model:
            logger.debug("muxterm %s: provider call failed: %s", what, exc)
            return None
        # WARNING, not debug, and deliberately every time it happens: a wrong
        # model id is a standing misconfiguration rather than a transient
        # blip, and the entire point of this path is that it should be
        # findable in a log instead of showing up as a feature that never
        # fires. Silencing this after the first occurrence would restore most
        # of the invisibility the retry exists to remove.
        logger.warning(
            "muxterm %s: provider rejected model %r (%s); retrying once with "
            "the provider's own default model",
            what,
            model,
            exc,
        )

    try:
        return await attempt(None)
    except asyncio.TimeoutError:
        logger.debug(
            "muxterm %s: default-model retry timed out after %.0fs", what, timeout_s
        )
        return None
    except Exception as exc:
        logger.debug("muxterm %s: default-model retry failed: %s", what, exc)
        return None


async def classify_turn(
    coordinator: Any,
    response_text: str,
    *,
    model: str | None = None,
) -> tuple[bool, str] | None:
    """Decide whether a finished turn is actually waiting on the human.

    Returns ``(needs_input, ask)``, or ``None`` when no verdict could be
    reached -- unreachable provider, timeout, malformed answer. ``None`` means
    "keep the structural verdict"; it never means "not blocked".
    """
    text = (response_text or "").strip()
    if not text:
        return None
    if len(text) > MAX_RESPONSE_CHARS:
        text = text[-MAX_RESPONSE_CHARS:]

    provider = _pick_provider(coordinator)
    if provider is None:
        return None

    try:
        from amplifier_core import ChatRequest, Message, ResponseFormatJsonSchema
    except Exception:
        return None

    request_kwargs: dict[str, Any] = {
        "messages": [
            Message(role="system", content=_SYSTEM),
            Message(role="user", content=text),
        ],
        "response_format": ResponseFormatJsonSchema(json_schema=_SCHEMA, strict=True),
        "temperature": 0.0,
        "max_output_tokens": 200,
    }

    response = await _complete_with_model_fallback(
        provider,
        ChatRequest,
        request_kwargs,
        model=model,
        timeout_s=CLASSIFY_TIMEOUT_S,
        what="classify",
    )
    if response is None:
        return None

    raw = _response_text(response).strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        logger.debug("muxterm classify: answer was not JSON: %.80s", raw)
        return None
    if not isinstance(parsed, dict):
        return None

    needs = parsed.get("needs_input")
    if not isinstance(needs, bool):
        return None
    summary = parsed.get("summary")
    if not isinstance(summary, str):
        # "ask" was this field's name before it covered both branches. Accept
        # it so a cached or older prompt still yields a usable line.
        legacy = parsed.get("ask")
        summary = legacy if isinstance(legacy, str) else ""
    if needs and not summary.strip():
        summary = _ask_from_text(text)
    summary = " ".join(summary.split())
    if len(summary) > MAX_ASK_CHARS:
        summary = summary[: MAX_ASK_CHARS - 1].rstrip() + "\u2026"
    return (needs, summary)
