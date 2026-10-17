# Agent-assisted Google connector registration

The reusable skill is [`muxterm-google-setup`](../../skills/muxterm-google-setup/SKILL.md).
It guides the Cloud Console work through Muxterm Browser Assistant, then hands off
credential entry and Google consent to the user. It does not require gcloud or the
desktop/SSH OAuth proof of concept, and does not reset existing connections.

## Start a setup chat

In **Connections → Gmail**, choose **Open setup chat**. Muxterm opens a new chat
with a service-specific prompt already in the composer; review it and send it.
Existing Google connections show **Open setup chat again** so you can ask the agent
to inspect or redo setup without removing the current connection. Manual client
entry and detailed requirements remain under **Setup requirements and manual entry**.

Give a browser-capable agent this prompt from the repository checkout:

```text
Read skills/muxterm-google-setup/SKILL.md and follow it to help me set up my
Muxterm Google connector using Browser Assistant.

Muxterm URL: <the instance I want to connect>
Requested services: <Gmail, Drive, Calendar, Docs, Sheets, or Slides>
Google account type: <personal Gmail or managed Workspace>
Google Cloud project: <existing project, or ask before creating one>

First check connector eligibility and the exact callback shown by Muxterm.
Ask before changing Google Cloud resources or existing registrations.
Keep me in control of login, legal consent, and secret entry; never put OAuth
secrets in chat, screenshots, tool arguments, source files, or logs.
```

This repository skill is not automatically installed globally or injected into
every chat. An agent can read it directly using the prompt above. Distribution
through the shared Skills catalog or a connector UI shortcut is a separate step.

## User-visible flow

```text
Choose Muxterm + services
    → check account eligibility and exact callback
    → pair Browser Assistant and enable its managed window
    → agent prepares the confirmed project, APIs, consent and Web client form
    → pause browser access
    → user creates client and uploads Web OAuth JSON on a private Muxterm page
    → agent uses an opaque receipt to configure the selected connections
    → user completes Google authorization privately
    → resume assistant on redacted connector status
    → check tools, approve selected read tools, optionally verify a safe call
```

Browser Assistant does not transfer credentials. While it is paused, the user uploads
the registration file directly to Muxterm, or enters credentials on the private page.
The agent sees only an opaque handle. Password masking alone does not make automated
credential entry secret-blind. See [Shared credential intake](connection-credential-intake.md)
for the tool contract, supported formats, and security boundaries.

## Current connector boundary

The existing Google cards use the official Workspace remote MCP services. Consult
their live eligibility requirements before registration: an OAuth app alone does
not provide personal Gmail support, preview enrollment, or production approval.
The skill stops rather than disguising an incompatible account as a setup failure.

Muxterm currently expects a **Web application** OAuth client. Copy the exact
callback from the chosen card; a LAN-only self-hosted address may require an
appropriate reachable HTTPS deployment before Google will accept and complete
that redirect. Do not reuse the desktop JSON from the SSH proof of concept.

One private upload can configure several selected service cards on the same registered
callback. Each card still needs its own authorization, tool check and explicit tool
selection. Credentials are stored per connection, not as a shared credential profile.

## Scope of this first increment

Included: a reusable, browser-guided registration procedure and launch prompt,
least-scope setup, private credential intake, opaque agent receipts, explicit human
checkpoints, and verification criteria.

Not included: automatic Google account creation, automatic project changes on
someone's account, secret transfer through the agent, production OAuth verification,
a personal-Gmail backend, or a claim of successful live Google
authorization. Those require their own implementation or a user-authorized run.
