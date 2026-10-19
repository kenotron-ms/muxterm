# Chat progress and Settings

Verified in the isolated dev app with a real browser, sessiond, and Codex chat.
The chat streamed two distinct progress updates around two shell commands, then
preserved those updates through history replay and browser reload. Visible sidebar
labels measured 12.5px, matching New Chat.

Workspaces has its own Settings section. Mobile Settings fills the viewport with
a Back control; desktop Settings remains a modal.

- [Live progress](progress-live.png)
- [Progress history and sidebar](progress-history.png)
- [Settings → About](settings-about.png)
- [Settings → Workspaces](settings-workspaces.png)
- [Settings page on mobile](settings-mobile.png)
- [Workspaces on mobile](settings-workspaces-mobile.png)

Version availability in these screenshots is a browser fixture (0.52.15 → 0.52.16).
Update application was intercepted in the browser; no binary update was executed.
