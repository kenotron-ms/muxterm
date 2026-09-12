/**
 * assistant-identity.ts -- the one place the chat/voice assistant's
 * user-facing name is spelled out, so every surface says the same thing.
 *
 * Display only. This does NOT parse, match, or route on either string --
 * there is exactly one assistant and one conversation in this build, so
 * there is nothing to route between. `ALIAS` exists so the nickname is
 * spelled the same way everywhere it is mentioned (tooltips, help text);
 * it is not read back out of user input, filenames, or transcripts.
 *
 * Mission Control is the enclosing applet-host/navigation surface and is
 * NOT part of this identity -- see title-bar.ts and mux-start-card.ts.
 */

/** Canonical, user-facing name for the chat/voice assistant. */
export const ASSISTANT_NAME = 'Operator';

/** Informal nickname, mentioned as an aside, not a second identity. */
export const ASSISTANT_ALIAS = 'Tank';
