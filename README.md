# 10db

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/travistruett/10db/badge)](https://scorecard.dev/viewer/?uri=github.com/travistruett/10db)

A local macOS control plane for running Claude Code sessions as a software factory: pick a project,
ask for N units of unblocked work, approve the batch, and walk away. Sessions hand off cleanly
before their context fills, questions and permission prompts land in one inbox, and only the
blocked work pauses.

Status: under construction. The design is in
[docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md](docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md).

## Install the app from main

| When                                 | Run                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Install or update 10db from main     | quit 10db (⌘Q), then `make install-app`, then open 10db                              |
| Something's wrong with the new build | quit 10db, then `make rollback-app` (it prints the matching database backup command) |

- GitHub builds it, so nothing compiles on your Mac. `make install-app` reuses the build of main's newest
  commit, or starts one and waits: the first install of a new commit waits about 15 minutes.
  `make install-app REF=<branch or tag>` installs another ref. It needs `gh` signed in, and it refuses while
  10db runs; it never quits 10db for you.
- The build is unsigned, so install it only this way. Gatekeeper refuses a copy opened from a download, and the
  Keychain may ask for access again after an update.
- Your data is backed up first, to `~/Library/Application Support/10db-backup-<stamp>/10db.sqlite`. The app it
  replaced stays beside the new one as `/Applications/10db.app.prev-<stamp>`, with the same stamp.

## Develop

Prerequisites: Homebrew, the Xcode Command Line Tools, and [mise](https://mise.jdx.dev) (`brew install mise`)
activated in your shell with `eval "$(mise activate zsh)"` in `~/.zshrc`. The complete new-machine
checklist is in [CONTRIBUTING.md](CONTRIBUTING.md#set-up).

- `mise install && pnpm install`: install the pinned tools, the dependencies and the git hooks.
  This includes Rust (about 1 GB). `make setup` does the same and asks before installing Rust.
- `pnpm dev`: run the daemon and the browser UI with a shared dev token, with state in `.dev/`.
- `pnpm --filter @10db/desktop dev:shell`: open the Tauri window ("10db Dev", its own app identifier, data in `.dev/data`) against that daemon. It runs beside the installed release app. Run `pnpm --filter @10db/desktop sidecar` once first.
- Factory and preview: the installed release app runs 10db's tasks on this repo; `pnpm dev` with `dev:shell` or http://localhost:1420 only previews the checkout and never runs tasks. While a task holds the checkout, don't hand-edit it; use a worktree in `../10db-worktrees/`.
- `make live-acceptance`: the manual §1.3 run on a Max subscription.
- `make gate`: every check; prints one summary line with each step's seconds (`GATE PASS format 4s · lint 31s · … (210s)`). Its e2e step needs the WebKit browser that `make setup` installs. It picks free ports for its daemon and UI, so gates in separate worktrees can run at once, beside `pnpm dev`; a port another process takes before the servers bind it fails the run at startup.
- `make check`: the fast check on what you changed.

Working rules for people and agents are in [AGENTS.md](AGENTS.md); how to contribute is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

10db assumes any agent might be steered by something it read, so nothing an agent can influence runs
outside a sandbox. Every agent command, every check run before shipping and every repository tool server
runs in the macOS kernel sandbox: it reads only its project and toolchains, writes only its checkout and
its own temporary folder, gets no credentials and reaches only the project's allowed hosts. 10db's own git
runs no repository code, and agents can't touch `.git` or push. How it works, how it is tested and what it
doesn't cover: [docs/security.md](docs/security.md).

## Deliver through pull requests

A project delivers `local` by default: sessions commit on whatever branch the checkout has. Choose
**One pull request per batch** when you create the project, or later in Settings, General (10db refuses
the change while the project has unfinished work), and 10db instead:

1. cuts `10db/<title>-<id>` from `origin/<base branch>` (default `main`) when you start a task or a set of
   tasks, provided the checkout is clean, no task runs in the project, `origin` exists and
   [`gh`](https://cli.github.com) 2.40 or later is installed and signed in (`gh auth login`);
2. runs the batch's tasks on that branch, and adds tasks you start while it is open;
3. when every task is done or cancelled, runs the gate on the clean branch, pushes it and opens one pull
   request titled `<prefix>: <batch title>`, or `<type>(<scope>): <subject>` worked out from the work when the project sets no prefix. The push runs no hook or other code from the repository and
   has a 30-minute limit; a fetch or a `gh` call gets 2 minutes. Merging stays with you.

Every refusal (a dirty checkout, the wrong branch, no `origin`, `gh` missing or signed out, a failed gate, a
rejected push) is an inbox card that says what to fix; nothing is pushed. A failed task's card offers Retry and
Ship anyway, which ships the batch without that task once the rest is done or cancelled. A task's drawer on the
board shows its branch and pull request, why the batch wasn't shipped, and offers Retry (when the batch failed),
Ship anyway (when a task failed) and Abandon, which keeps the branch and cancels its unfinished tasks once
nothing on it is running. When several tasks share a branch, one line above the columns names it. 10db
never force-pushes, and agents can't push, merge or open pull requests themselves.

## Accounts

Every project runs on an account: who pays for its sessions. A fresh 10db has one, **Claude plan** (the default account), which is
the Claude Code login you already use (`claude /login`, in `CLAUDE_CONFIG_DIR` if your shell sets it).
10db records its email the first time a task runs, tells you in the inbox which email it recorded
("Claude plan runs as …"), and refuses any session that reports a different one.

Add and manage accounts in Settings › Accounts:

- **Add account** asks for a kind and a label (a metered account also takes a monthly cap). A second Claude
  subscription shows the sign-in command for its own config directory: run it in a terminal, then press
  **Check sign-in**. 10db shows the email it found, and **Confirm** records it as the account's identity.
- A keyed account (an Anthropic API key, a gateway's token or Bedrock on a bearer token) takes its secret in a
  password field. The secret goes to your login Keychain, never to 10db's database, and the screen forgets it as
  soon as it is sent. After a check, an API-key or Bedrock account that reports an organization can **Require** it.
- Select an account to edit its label, caps and settings, or to archive it. The table shows each account's kind,
  recorded identity and this month's usage against its cap.

The same routes exist on the daemon's API (`/accounts`).

The inbox also asks you to confirm the email it found after a new subscription signs in. Pick a
project's account in Settings, Billing. Sessions on an account run under its own lane cap and usage limits; a
metered account stops starting sessions at its monthly cap until the next month or a raised cap.
`GET /accounts/<id>/usage?month=YYYY-MM` shows its tokens and dollars per project.

A project can move to another account in Settings, Billing, even with work in flight. A running session
finishes where it is, and each lane's next session runs on the new account, fresh from its latest handoff;
work that was neither committed nor handed off stays behind. When an account hits its usage limit, each
project with work on it gets an inbox card offering to continue on another account (a project whose work queues
during the pause gets it then, once), and once the limit resets 10db asks whether to move back. Name a fallback account in Billing, and 10db moves a project with work in
flight there by itself: on a Claude subscription when it reaches 95% of a usage limit ("Hand off at" in
Billing changes that), after asking its running lanes to hand off; on any account at the limit itself. The fallback
must be ready to run, and a metered one needs a monthly cap, because nobody approves that spend.

## Model data from Artificial Analysis

10db can route each step on [Artificial Analysis](https://artificialanalysis.ai) benchmark scores, using your own free API key. Add it with `security add-generic-password -U -s 10db -a artificial-analysis-api-key -w`, which prompts for the key (`-U` replaces an existing item, so re-running it updates the key). Run it in a terminal that can prompt. Then restart 10db so it syncs; otherwise the next scheduled sync is up to 24 hours away (a sync button comes later). The data is fetched to your machine only, and is not covered by this repository's license. Source: Artificial Analysis (artificialanalysis.ai).

## License

Apache-2.0. See [LICENSE](LICENSE).
