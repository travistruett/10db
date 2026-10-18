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

## Model data from Artificial Analysis

10db can route each step on [Artificial Analysis](https://artificialanalysis.ai) benchmark scores, using your own free API key. Add it with `security add-generic-password -s 10db -a artificial-analysis-api-key -w`, which prompts for the key. The data is fetched to your machine only, and is not covered by this repository's license. Source: Artificial Analysis (artificialanalysis.ai).

## License

Apache-2.0. See [LICENSE](LICENSE).
