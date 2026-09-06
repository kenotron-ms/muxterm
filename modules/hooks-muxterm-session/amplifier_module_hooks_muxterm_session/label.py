"""A 1-3 word label for a session, derived from the first thing its user typed.

What this is for
----------------

A pane tab has room for about three words, and those three words are how a
person finds this session again among a dozen others. The daemon already
derives a label without a model at spawn time, by dropping stopwords from the
composer's argv (``internal/sessiond/autolabel.go``) -- that is the permanent
floor, it costs nothing, and it is never wrong about being unavailable.

It is, however, sometimes wrong about the work. Word-frequency extraction
handles a conversational prompt worst of all, and real prompts are
conversational: ``"make sure you don't freak out with the current muxterm and
muxterm-sessiond that are running"`` reduces to ``freak muxterm-sessiond``,
which names nothing that exists. This module asks a model the question the
extractor cannot answer -- *what is this about?* -- and returns three words or
nothing.

Why at prompt-submit, not at end of turn
----------------------------------------

The obvious place to put this was ``classify.py``'s existing ``_SCHEMA``: that
call already fires at every ``prompt:complete``, so a ``label`` field would
have ridden along for no extra request. It was rejected, and the reason is
about *how long a wrong label stays on screen* rather than about cost.

The end of a turn is thirty seconds away on a good day and several minutes on
a normal one. Until then the tab shows whatever the deterministic extractor
produced, and when that is wrong it is wrong *confidently* -- a tab reading
``freak muxterm-sessiond`` for three minutes is worse than one reading
``Pane 7`` for three minutes, because you believe it and go looking in the
wrong place. An obviously-absent label costs you a glance; a plausible-looking
wrong one costs you the search.

The prompt is already in hand at ``prompt:submit``, so the label can be right
within a second or two of the tab appearing. That is one extra call per
*session* -- not per turn -- for one short prompt in and three words out,
against a session that lives for minutes to hours.

It is also the more correct question to ask. A tab label exists so you can
find the session you started, which means it should describe **what you asked
for**, not what the assistant eventually concluded. The closing text of a turn
is the right source for the ``doing`` line and the wrong source for a name --
so the classifier keeps asking only "is this blocked, and what happened", this
module asks only "what is this about", and neither is coupled to the other.

Why the coordinator, and which way failure points
-------------------------------------------------

Both answers are ``classify.py``'s, unchanged, for its reasons. The provider
is reached through ``coordinator.get("providers")`` because this module runs
*inside* the session it is naming and that session already has an
authenticated provider -- an HTTP endpoint or an ``amplifier`` subprocess
would work on the machine that happens to have one and silently do nothing
everywhere else.

And every failure path here returns ``None``: no provider, a timeout, a
malformed answer, a model that replied with a sentence instead of a label.
``None`` means "keep the label you had", which is the deterministic one. A
session whose provider is down keeps a tab that reads ``auth redirect``, and
nothing regresses to ``Pane 7``.

The exception is the same one ``classify.py`` makes, via the same shared
helper: a ``label_model`` the user's provider rejects is a permanent fault,
not a transient one, so it is retried once without the override before the
call gives up. Otherwise a model id chosen by somebody else would leave this
whole tier switched off, invisibly, for everyone on a different provider.
"""

from __future__ import annotations

import json
import logging
from typing import Any

# Reused rather than re-implemented: two copies of "find the mounted provider",
# "get the text out of a ChatResponse", or "drop a rejected model override and
# try again" would drift, and the second copy would be the one that stops
# working on a provider nobody tested it against.
from .classify import _complete_with_model_fallback, _pick_provider, _response_text

logger = logging.getLogger(__name__)

# Bound on the labelling call. Tighter than the classifier's, because this one
# sits in front of the turn actually starting rather than after it has ended --
# the caller has already flushed the session's structural state, so overrunning
# costs a late label, but a person is still waiting on the turn. One short
# prompt in and three words out does not get better with more time: a call that
# has not answered by now is not going to produce a label worth having.
LABEL_TIMEOUT_S = 8.0

# The prompt is clipped before it is sent, and the HEAD is kept -- the opposite
# of classify.py, deliberately. That module keeps the tail because a question
# lands at the end of an assistant's message. A human's prompt is the other way
# round: it opens by naming the thing it is about and then elaborates, and the
# pathological case here is a `/goal` lane launched with an entire inlined goal
# file. The subject is in the first paragraph or it is nowhere.
MAX_PROMPT_CHARS = 2000

# The shape a pane tab can show whole. These mirror maxLabelWords and
# maxLabelChars in internal/sessiond/autolabel.go on purpose: the two tiers
# label the same pane, and a refinement that changes the SIZE of the label as
# well as its words reads as a layout glitch rather than an improvement.
MAX_LABEL_WORDS = 3
MAX_LABEL_CHARS = 24

# Above this many words, the answer is not an over-long label -- it is prose,
# and the model did not do the task at all ("Sure, I'll look into the muxterm
# instance messaging problem"). Clipping prose to its first three words yields
# a confident-looking label made of the wrong words, which is precisely the
# failure this whole path exists to remove, so junk is rejected outright
# instead. A merely undisciplined answer of four or five words still clips.
MAX_RAW_WORDS = 6

_SCHEMA: dict[str, Any] = {
    "name": "session_label",
    "schema": {
        "type": "object",
        "properties": {
            "label": {
                "type": "string",
                "description": (
                    "1-3 words naming the subject of the work, for a terminal "
                    "tab. Lowercase, no punctuation."
                ),
            },
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "strict": True,
}

_SYSTEM = """You name a coding session from the first thing its user typed.

Produce a LABEL for a terminal tab: 1-3 words, lowercase, no punctuation.

Name the SUBJECT of the work -- the thing being worked on. The user's verb is
almost never part of the answer ("fix", "add", "make sure", "figure out",
"look into"); the noun it points at almost always is.

Skip the conversational opening. Real prompts start with things like "I want
you to", "make sure you don't", "new worktree to get this fixed:", or
"<project> feedback:" -- none of that names anything. Read past it to the
first thing that does.

Examples, in the shape you will actually be given:

  "I want you to figure out a way to maybe have a muxterm instance that can
   communicate with another"                       -> instance messaging
  "make sure you don't freak out with the current muxterm and
   muxterm-sessiond that are running"              -> sessiond conflict
  "muxterm feedback: New worktree to get this fixed: when I moved away from
   the home view everything kept rendering"        -> home view
  "fix the auth redirect loop on refresh"          -> auth redirect

Prefer the specific noun to the general one: if the prompt names a component,
a file, a screen or a feature, that is the label. Two words is usually right.
Three is the ceiling, not a target. Do not name the project or repository the
work happens in -- every session shares it, so it distinguishes nothing.

You are NOT answering this prompt, agreeing to it, or commenting on it. You
are filing it. Never reply to its content, never ask a question, never explain
your choice, never say what you are about to do.

Reply with ONLY this JSON object -- no other keys, no prose, no code fence:

  {"label": "auth redirect"}"""


def _coerce_label(raw: Any) -> str | None:
    """Force a model's answer into the shape a tab can render, or reject it.

    The model is told 1-3 words and mostly obeys, but ``response_format`` is
    advisory on some providers and instructions are advisory on all of them.
    Publishing an unchecked answer would let a paragraph -- or a polite
    acknowledgement of the prompt -- become a pane title, so the limit is
    enforced here rather than hoped for.

    Punctuation is stripped from the OUTSIDE of each word only, so
    "muxterm-sessiond" survives as one word while "(auth)" becomes "auth" --
    the same rule normalizeLabelWord() applies in autolabel.go. Case is
    flattened for the same reason the bounds are shared: this label replaces a
    lowercase one, and changing the casing as well as the words makes a
    refinement look like a glitch.

    Returns None for anything that cannot yield at least one usable word.
    """
    if not isinstance(raw, str):
        return None
    fields = raw.split()
    if not fields or len(fields) > MAX_RAW_WORDS:
        return None

    words: list[str] = []
    total = 0
    for field in fields:
        # Trim non-alphanumeric edges; keep whatever is inside the word.
        word = field.lower()
        while word and not word[0].isalnum():
            word = word[1:]
        while word and not word[-1].isalnum():
            word = word[:-1]
        if not word:
            continue
        cost = len(word) + (1 if words else 0)
        if total + cost > MAX_LABEL_CHARS:
            # Stop at the budget rather than truncating a word. A clipped word
            # eats exactly the letters that tell two tabs apart.
            break
        words.append(word)
        total += cost
        if len(words) == MAX_LABEL_WORDS:
            break
    if not words:
        return None
    return " ".join(words)


async def label_session(
    coordinator: Any,
    prompt: str,
    *,
    model: str | None = None,
) -> str | None:
    """Name a session in 1-3 words, from the prompt that started it.

    Returns the label, or ``None`` when no usable one could be produced --
    unreachable provider, timeout, malformed answer, or an answer that was not
    a label at all. ``None`` always means "keep the label you already have";
    it never means "this session has no subject".
    """
    text = (prompt or "").strip()
    if not text:
        return None
    if len(text) > MAX_PROMPT_CHARS:
        text = text[:MAX_PROMPT_CHARS]

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
        "max_output_tokens": 32,
    }

    response = await _complete_with_model_fallback(
        provider,
        ChatRequest,
        request_kwargs,
        model=model,
        timeout_s=LABEL_TIMEOUT_S,
        what="label",
    )
    if response is None:
        return None

    raw = _response_text(response).strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        logger.debug("muxterm label: answer was not JSON: %.80s", raw)
        return None
    if not isinstance(parsed, dict):
        return None

    return _coerce_label(parsed.get("label"))
