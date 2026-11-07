# Connect signs an account in from the app, through the account's own agent

- **Date:** 2026-11-06
- **Amends:** `decisions/2026-11-05-chatgpt-plan-through-the-codex-app-server.md`

## Decision

The drawer of an account that signs in with a login (`claude_subscription` or `codex_signin`) leads with a Connect button. The builder approved the flow: click Connect, 10db
starts the login for that account and opens the browser, they sign in, and 10db sees it finish and runs the identity
check itself.

- The daemon starts `codex app-server` with the account's launch environment, the one the identity check uses, so the
  login lands in the account's own `CODEX_HOME`. It sends `account/login/start` with `{type: 'chatgpt'}` and keeps the
  process until `account/login/completed` names the same `loginId`, a cancel (`account/login/cancel`), the process
  exiting or ten minutes on the injected clock. It always closes the process.
- 10db opens an `authUrl` only when one is returned and it is `https` on `auth.openai.com`; the desktop opener's allow list gains
  `https://auth.openai.com/*` and nothing wider.
- Codex still writes the login. 10db never reads, copies or stores it and learns only whether the sign-in finished.
  Neither the address nor anything the app-server printed is logged or sent on; the end reaches the UI as an
  `account.login_ended` event with a fixed message.
- One sign-in runs at a time across the daemon, because Codex listens for the callback on a fixed local port (1455); the Claude flow shares the slot so the UI has one rule.
  A second start is a conflict naming the account already connecting.
- A Claude subscription runs `claude auth login --claudeai` (the `claude` the daemon resolved) on the same launch
  environment, with no stdin and its output dropped. It opens the browser itself and returns no page, so the
  response's `authUrl` is null. Exit 0 is success; cancel and the ten minute deadline kill the child. Its behaviour
  with no terminal is unverified, which the deadline and Cancel cover.
- Both kinds share the one daemon-wide slot, the event and the cancel; the routed adapter picks the agent.
- The slot is a daemon read (`GET /accounts/connecting`), and the UI's waiting state and Cancel come from it, so they
  survive a closed drawer, another window and a restart.
- A sign-in replaces the login that lanes on the account use: Connect is refused while a lane runs on the account (a lane counts on the account of its live session, or its project's account while it is still starting),
  the scheduler starts nothing there until the sign-in is over, and the default account's Connect asks for a confirming
  click.
- Each agent process is stopped (SIGTERM, then SIGKILL after 2 s) before the slot is freed, and the daemon's shutdown
  stops a sign-in under way before the database closes.
- The Terminal command remains for both, as "Sign in from Terminal instead".

## Why

A sign-in from Terminal asks the builder to copy a command with an environment variable into a shell and then come
back and check. The app-server already offers the same browser sign-in as a request, so the app can start it and
see its end, with no new place a credential lives. The fixed callback port makes concurrent sign-ins impossible, so
the daemon refuses them instead of letting the second fail in Codex. The protocol was read from Codex 0.154.0's
generated schema; the flow is tested against a fake app-server. A live Codex 0.154.0 later confirmed that the completion carries the start's `loginId` and that a cancel frees port 1455 within 500 ms.

## Known gaps

- Plan/Shape conversations and identity probes on the account are not counted as running lanes. The builder is present
  for a conversation, and an identity is read again at the next start.
- The Codex spawn seam drops its working directory, as the identity probe's always has.
- A daemon that crashes leaves an agent process of a sign-in running; the next sign-in finds the port taken and says so.
- The port-in-use error text and how `claude auth login` behaves with no terminal have not been observed.
