# GitHub landing page strategy

## Audience and job

The primary visitor is a developer who already uses a coding-agent harness and has signed in to its subscription or configured its provider. They use terminals heavily, may run more than one agent or project, and want to move between a desk and a phone without losing the thread of the work. A second visitor wants the terminal workspace without any AI setup.

The landing page should help either visitor answer three questions quickly: **Can I keep my current tools? What becomes easier day to day? How do I start?**

## Positioning

**Use your existing harnesses and subscriptions through one pleasant, consistent workspace wherever you work.** Muxterm puts persistent terminals, agent sessions, files, and durable Work within reach of one another. Its visual design should make status and next actions clear, and then leave room for the task itself.

This leads with continuity of the person's own tools and paid plans. The implementation details—Go sessiond, VT replay, native lifecycle reporting, SSH remotes, and MCP—are proof that the promise works. They belong after the human benefit.

## Message order

1. **Bring what you have.** Show Codex, Claude Code, and Amplifier with their normal sign-ins or provider setup. Say clearly that terminals work without AI.
2. **One UX as you move.** Explain browser/PWA access, the same session records, and remote projects through a home URL. Avoid implying that a local-only install is automatically reachable from the internet.
3. **Enjoy the flow.** Show a quiet, responsive interface with terminal, chat, Files, and Work. Use an actual browser capture for product proof; the branded SVG is an illustration, not a screenshot.
4. **Know what happened.** Explain terminal reconnection and Work state in plain language before introducing architecture.
5. **Start in minutes.** Put macOS and Linux commands, the first useful workflow, and deeper guides near the top.

## Proof and boundaries

| Promise | Product evidence |
| --- | --- |
| Existing harnesses and subscriptions | Native Codex, Claude Code, and Amplifier setup and session reporting; harnesses use their own credentials. |
| Sessions remain useful across browser disconnects | `sessiond` owns PTYs and cell-grid replay independently of the web server. |
| One place to follow agent work | Durable chats, Work records, dispatch, and a Work digest in chat. |
| Useful across devices | Responsive browser UI and PWA; SSH remote projects behind one home Muxterm URL. |
| A workspace that gets out of the way | Flexible panes, adjacent Files, palette-derived chrome, and focused Work status. |

Claims about Work-event-triggered Jobs, a universal search palette, or any other pending feature should wait for a verified release. Browser Assistant is absent from the current main checkout, so it should not be a landing-page claim until its source and setup guide ship. Avoid a fixed MCP tool count because the surface changes frequently.

## Page and channel choices

The README is the first landing page: a short value proposition, a branded illustration, a direct install path, a five-step first workflow, and product proof. Detailed operational material moves into linked guides so a visitor can scan the page without losing the install and safety information. The next marketing asset should be a deliberate real-product demo that shows a terminal, an agent chat, and Work progressing on a recognizable task; verification fixtures are useful for accuracy but weak as a public story.

The same message can later be adapted for the repository description, release notes, and a short demo video: **your harnesses, your subscriptions, one workspace wherever you work**. Judge the page by whether a new visitor can identify the supported harnesses and reach a working terminal or chat without reading the architecture section.

## Research used

- [GitHub's README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) prioritizes what a project does, why it is useful, and how to start.
- [Warp's current overview](https://docs.warp.dev/) shows how crowded the terminal-plus-agent category is. Muxterm's page should make its specific promise—existing harnesses and subscriptions carried into a persistent, cross-device workspace—immediately legible.
