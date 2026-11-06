# A project can run on a ChatGPT plan through the Codex app-server, from a login on this machine

- **Date:** 2026-11-05
- **Amends:** decision 4 ("Claude first")

## Decision

Travis decided on 2026-11-05: start with a login on this machine through `codex app-server`, then move to Sign in
with ChatGPT once that is stable. Decision 4 made Claude the first provider and left Codex as the next adapter,
blocked on OpenAI's terms. The terms no longer block it, and Codex is built as that adapter.

- A `codex_signin` account kind runs a project's lanes through `codex app-server`. It is not metered: `costUsd` stays
  null and no monthly cap applies.
- Each such account has a Codex home of its own at `<dataDir>/accounts/<id>/codex`, mode 700. The builder runs
  `CODEX_HOME='<dir>' codex login` there, and Codex writes its own login. A separate home replaces reusing `~/.codex`.
  10db never reads, copies or stores a ChatGPT credential.
- The identity of the account is the email and the workspace together. One email can hold several workspaces, and the
  workspace chosen at sign-in decides which plan pays, so the email alone can't tell them apart. A sign-in to another
  workspace on the same email fails the identity check and is refused, not billed. The plan's name is never compared.
- `forced_login_method = "chatgpt"` in the home keeps an API key from billing instead, and the launch strips
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN` and `CODEX_HOME` from a Codex launch only.
- Out of scope: `openai_api_key` accounts, Sign in with ChatGPT, brainstorm chat on a ChatGPT account (refused with an
  error that says so), and `complete()` on Codex.

## Why

OpenAI's app-server page says app-server authentication was never permitted for commercial or hosted services, and that
a local or open-source app built on it can keep using it. 10db is local, Apache-2.0, public and not hosted, so it
is on the allowed side. That page was read through a summarising tool, and OpenAI's Terms of Use themselves are still
unread. A paid 10db tier, or anything hosted, would reopen the question.

Ampsio has its own ChatGPT plan, and the rule is that each project's work is billed where it belongs, so Ampsio joins
10db on ChatGPT rather than on Claude first.

A separate home is needed because `~/.codex` would load the builder's own MCP servers into a lane, and `thread/start`
writes trust entries into the `config.toml` of the home it runs on. 10db holds no credential because the failure to
avoid is 10db itself holding a ChatGPT credential.

The design is `docs/superpowers/specs/2026-11-05-10db-chatgpt-plan-design.md` and the evidence is
`docs/architecture/research/spike-16-codex-app-server.md`.
