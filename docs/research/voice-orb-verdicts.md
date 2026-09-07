# Voice orb — recorded verdicts

Generated, not hand-written. Regenerate with:

```console
node docs/research/voice-orb-evidence.mjs --verdicts > docs/research/voice-orb-verdicts.md
```

Captured 2026-09-07 08:19:12Z against
`docs/research/voice-orb-mock.html` in headless Chrome. Every number is a
`getComputedStyle` or `getBoundingClientRect` reading taken during a live transition.

The twelve terminal verdicts below are **derived from the 36 measured cells**, not
asserted: a transition passes iff all six criteria hold for it, and a criterion passes
iff it holds on all six transitions. A failing cell propagates to a BLOCKED verdict with
the failing measurement named — there is no path here by which a failure yields a PASS.

## Terminal verdicts

| # | item | verdict | derived from |
|---|---|---|---|
| **T1** | idle → listening | **PASS** | all six criteria hold; see the row below |
| **T2** | listening → thinking | **PASS** | all six criteria hold; see the row below |
| **T3** | thinking → speaking | **PASS** | all six criteria hold; see the row below |
| **T4** | speaking → listening | **PASS** | all six criteria hold; see the row below |
| **T5** | listening → idle | **PASS** | all six criteria hold; see the row below |
| **T6** | speaking → idle | **PASS** | all six criteria hold; see the row below |
| **K1** | no discontinuous jump | **PASS** | holds on all six transitions; per-transition measurements below |
| **K2** | no snap-through-base | **PASS** | holds on all six transitions; per-transition measurements below |
| **K3** | interruptible | **PASS** | holds on all six transitions; per-transition measurements below |
| **K4** | compositor-only | **PASS** | holds on all six transitions; per-transition measurements below |
| **K5** | reduced motion | **PASS** | holds on all six transitions; per-transition measurements below |
| **K6** | duration and easing stated | **PASS** | holds on all six transitions; per-transition measurements below |
| **Persona** | use the AI Elements persona component | **ADOPTED** | state model (`persona.tsx:281-294`) and layered visual approach ported to Lit; timing values NOT PORTABLE — the upstream source contains none. See `persona-reference/README.md`. |

**BLOCKED items: 0.** Every item carries PASS, so no BLOCKED reasons are required. Had any cell failed, the verdict above would read BLOCKED with the failing measurement named.

## The 36 cells

| transition | K1<br>no discontinuous jump | K2<br>no snap-through-base | K3<br>interruptible | K4<br>compositor-only | K5<br>reduced motion | K6<br>duration and easing stated |
|---|---|---|---|---|---|---|
| **T1** idle → listening | PASS | PASS | PASS | PASS | PASS | PASS |
| **T2** listening → thinking | PASS | PASS | PASS | PASS | PASS | PASS |
| **T3** thinking → speaking | PASS | PASS | PASS | PASS | PASS | PASS |
| **T4** speaking → listening | PASS | PASS | PASS | PASS | PASS | PASS |
| **T5** listening → idle | PASS | PASS | PASS | PASS | PASS | PASS |
| **T6** speaking → idle | PASS | PASS | PASS | PASS | PASS | PASS |

### The measurement in every cell

#### T1  idle → listening

- **K1** PASS — velocity x nominal: glow 2.71, rect 1.61 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4795 (mid-flight); seam d(glow) 0.02978; velocity 2.72
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 0; glow d 0.28; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 422 / 422 ms (stated 420, spread 1ms)

#### T2  listening → thinking

- **K1** PASS — velocity x nominal: glow 2.69, rect 2.16 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.9793: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "speaking" at 140ms with incoming weight 0.4898 (mid-flight); seam d(glow) 0.00739; velocity 2.23
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 65.47; glow d 0.07; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 423 / 422 ms (stated 420, spread 0ms)

#### T3  thinking → speaking

- **K1** PASS — velocity x nominal: glow 2.69, rect 0.74 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.9793: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "listening" at 140ms with incoming weight 0.4874 (mid-flight); seam d(glow) 0.02010; velocity 2.66
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 81.93; glow d 0.19; 43 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 422 / 422 ms (stated 420, spread 1ms)

#### T4  speaking → listening

- **K1** PASS — velocity x nominal: glow 3.01, rect 0.38 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 1.0082: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4904 (mid-flight); seam d(glow) 0.01259; velocity 1.87
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 45.79; glow d 0.12; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 425 / 423 / 422 ms (stated 420, spread 2ms)

#### T5  listening → idle

- **K1** PASS — velocity x nominal: glow 2.69, rect 1.07 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4904 (mid-flight); seam d(glow) 0.02956; velocity 2.67
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 0; glow d 0.28; 43 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 423 / 423 ms (stated 420, spread 1ms)

#### T6  speaking → idle

- **K1** PASS — velocity x nominal: glow 2.68, rect 0.95 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4838 (mid-flight); seam d(glow) 0.04215; velocity 3.04
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 45.79; glow d 0.4; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 422 / 422 ms (stated 420, spread 1ms)

## Where the rest of the evidence lives

| | |
|---|---|
| unreduced per-frame samples, all six transitions + three interrupts | `docs/research/voice-orb-samples.txt` |
| which technique is running, measured at runtime | `--technique` (`getAnimations()` = 0, Σw = 1.000000) |
| the artifact's controls, driven by clicking them | `--ui` |
| the technique asserted in CI, mutation-proven | `web/src/lib/orb-persona.test.ts` (30 tests, `npm test`) |
| the engine | `web/src/lib/orb-persona.ts` |
| the artifact | `docs/research/voice-orb-mock.html` |

