# 10db

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/travistruett/10db/badge)](https://scorecard.dev/viewer/?uri=github.com/travistruett/10db)

A local macOS control plane for running Claude Code sessions as a software factory: pick a project,
ask for N units of unblocked work, approve the batch, and walk away. Sessions hand off cleanly
before their context fills, questions and permission prompts land in one inbox, and only the
blocked work pauses.

Status: under construction. The design is in
[docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md](docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md).

## Develop

Prerequisites: Homebrew, the Xcode Command Line Tools, and [mise](https://mise.jdx.dev) (`brew install mise`)
activated in your shell with `eval "$(mise activate zsh)"` in `~/.zshrc`. The complete new-machine
checklist is in [CONTRIBUTING.md](CONTRIBUTING.md#set-up).

- `mise install && pnpm install`: install the pinned tools, the dependencies and the git hooks.
  This includes Rust (about 1 GB). `make setup` does the same and asks before installing Rust.
- `pnpm dev`: run the daemon and the browser UI with a shared dev token, with state in `.dev/`.
- `TENDB_DATA_DIR="$PWD/.dev/data" pnpm --filter @10db/desktop dev:shell`: open the Tauri window against that daemon. Run `pnpm --filter @10db/desktop sidecar` once first.
- `make live-acceptance`: the manual §1.3 run on a Max subscription.
- `make gate`: every check; prints one summary line. Its e2e step needs ports 1420 and 4318 free (stop `pnpm dev`) and the WebKit browser that `make setup` installs.
- `make check`: the fast check on what you changed.

Working rules for people and agents are in [AGENTS.md](AGENTS.md); how to contribute is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Deliver through pull requests

A project delivers `local` by default: sessions commit on whatever branch the checkout has. Choose
**One pull request per batch** when you create the project, or later in Settings, General (10db refuses
the change while the project has unfinished work), and 10db instead:

1. cuts `10db/<title>-<id>` from `origin/<base branch>` (default `main`) when you start a task or a set of
   tasks, provided the checkout is clean, no task runs in the project, `origin` exists and
   [`gh`](https://cli.github.com) is installed and signed in (`gh auth login`);
2. runs the batch's tasks on that branch, and adds tasks you start while it is open;
3. when every task is done or cancelled, runs the gate on the clean branch, pushes it and opens one pull
   request titled `<prefix>: <batch title>` (the batch title alone when the project sets no prefix).
   The push runs your clone's pre-push hook, with the gate's time limit (30 minutes by default); a fetch
   or a `gh` call gets 2 minutes. Merging stays with you.

Every refusal (a dirty checkout, the wrong branch, no `origin`, `gh` missing or signed out, a failed gate, a
rejected push) is an inbox card that says what to fix; nothing is pushed. A failed task's card offers Retry and
Ship anyway, which ships the batch without that task once the rest is done or cancelled. The board's batch strip
shows the batch and offers Retry (when the batch failed), Ship anyway (when a task failed) and Abandon. 10db
never force-pushes, and agents can't push, merge or open pull requests themselves.

## Model data from Artificial Analysis

10db can route each step on [Artificial Analysis](https://artificialanalysis.ai) benchmark scores, using your own free API key. Add it with `security add-generic-password -U -s 10db -a artificial-analysis-api-key -w`, which prompts for the key (`-U` replaces an existing item, so re-running it updates the key). Run it in a terminal that can prompt. Then restart 10db so it syncs; otherwise the next scheduled sync is up to 24 hours away (a sync button comes later). The data is fetched to your machine only, and is not covered by this repository's license. Source: Artificial Analysis (artificialanalysis.ai).

## License

Apache-2.0. See [LICENSE](LICENSE).
