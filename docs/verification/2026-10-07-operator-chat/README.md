# Operator chat browser views

Captured against an isolated `make dev-local` instance with real Codex SDK
chats. Any chat can become an operator from the permission and mode menu in its
composer. The Status tab then opens with no lanes and directs the user to ask
the chat to start or attach one. In the active view, a linked Codex lane's
lifecycle and final answer appear in one status card. The operator separately
summarizes the result. This lane used a labeled turn estimate because its plan
tool was unavailable in the verification environment.

![Composer menu with Operator mode switch](operator-before.png)

![New operator with an empty Status tab](operator-empty.png)

![Operator with a completed Codex lane status card](operator-active.png)
