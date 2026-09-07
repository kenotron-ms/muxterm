# AI Elements `Persona` — vendored reference

Verbatim upstream copies, kept here so the port in `web/src/lib/orb-persona.ts`
does not depend on a `/tmp` directory surviving, or on the upstream repo staying
put.

| File | Upstream path |
|---|---|
| `persona.tsx` | `packages/elements/src/persona.tsx` |
| `persona.mdx` | `apps/docs/content/components/_voice/persona.mdx` |
| `persona-skill-reference.md` | `skills/ai-elements/references/persona.md` |
| `LICENSE` | repository root |

- **Source:** <https://github.com/vercel/ai-elements> (branch `main`)
- **Fetched:** 2026-09-07
- **Licence:** Apache-2.0, Copyright 2023 Vercel, Inc. — see `LICENSE`
- **Verified identical to upstream `main` at fetch time.**
  `persona.tsx` sha256 `5c649409c4c08408959eff5ec43a179ca6f585ec101ca7f8322348510b6b0375`

  ```console
  $ curl -sSL https://raw.githubusercontent.com/vercel/ai-elements/main/packages/elements/src/persona.tsx \
      | diff - docs/research/persona-reference/persona.tsx && echo identical
  identical
  ```

## What was taken from it

The component itself is React + Rive/WebGL2. muxterm's frontend is Lit, and the
visual is a `.riv` binary served from Vercel blob storage, so there is nothing
to drop in. What ports is the **state model**, which is where its continuity
actually comes from — `persona.tsx:281-294`:

```tsx
listeningInput.value = state === "listening";
thinkingInput.value  = state === "thinking";
speakingInput.value  = state === "speaking";
asleepInput.value    = state === "asleep";
```

Four **independent** inputs, pushed every render into one state machine that is
always running (`autoplay: true`, `persona.tsx:257`). `idle` has no input at
all — it is the all-false case. Nothing is keyed to entering a state, nothing
restarts, and React never touches the animation; it only moves targets, and Rive
blends from wherever the blend currently sits.

`web/src/lib/orb-persona.ts` reproduces that shape without Rive: the four
booleans become a weight vector over the states, the always-playing state
machine becomes one `requestAnimationFrame` loop, and blending becomes a convex
combination of per-state poses with `Σw ≡ 1`. Colour uses the layered
cross-fade the Rive artboards use — one tinted layer per state, opacities driven
by the same weights — rather than an interpolated gradient.

The full rationale, and the properties that follow from this shape, are in the
header comment of `web/src/lib/orb-persona.ts`.
