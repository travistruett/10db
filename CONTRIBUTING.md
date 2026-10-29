# Contributing to 10db

Thanks for helping. The rules below bind everyone equally: people, Claude Code and Codex. The
working rules for code are in [AGENTS.md](AGENTS.md).

## Set up

Follow these steps in order on a new computer. Each one says how to check it worked.

1. **macOS on Apple Silicon.** Releases are arm64 only, and the toolchain below is only tested
   there.
2. **Xcode Command Line Tools** (they bring git, the compiler and the linker):
   ```bash
   xcode-select --install
   xcode-select -p
   ```
   The second command prints a path such as `/Library/Developer/CommandLineTools` once the install
   has finished.
3. **Homebrew.** Install it from https://brew.sh and follow the instructions it prints at the end.
4. **Your git identity.** Commits record it, and git refuses to commit without it:
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```
   Use the email address on your GitHub account.
5. **GitHub access.** The repository is private until it goes public, so sign in before you clone:
   ```bash
   brew install gh
   gh auth login
   gh auth status
   ```
   Choose GitHub.com and your protocol (HTTPS, or SSH if you already have a key on GitHub), and
   answer yes when it offers to set up git credentials. `gh auth status` should say you are
   logged in.
6. **mise**, which installs and pins every other tool:
   ```bash
   brew install mise
   ```
7. **Activate mise in your shell**, then open a new terminal. For zsh, add this line to
   `~/.zshrc`:
   ```bash
   eval "$(mise activate zsh)"
   ```
   For bash, add `eval "$(mise activate bash)"` to `~/.bashrc`. The git hooks need the pinned
   tools on `PATH`. A GUI or IDE git client runs hooks without your shell profile, so add
   `~/.local/share/mise/shims` to its `PATH` too. Claude Code sessions get the shims from the
   `SessionStart` hook in `.claude/settings.json`, which finds mise on the `PATH` Claude Code
   started with, so start Claude Code from a shell where mise is activated.
8. **Clone the repository and trust its mise config:**
   ```bash
   gh repo clone travistruett/10db
   cd 10db
   ```
   Without `gh`, `git clone git@github.com:travistruett/10db.git` (SSH key on GitHub) or
   `git clone https://github.com/travistruett/10db.git` (git credentials from step 5) does the
   same. The first time you enter the directory, mise asks whether to trust `mise.toml`. Answer
   yes, or run `mise trust` in the repository root. Nothing installs until you run step 9.
9. **Run the setup**, from the repository root:
   ```bash
   make setup
   ```
   It first asks whether to install Rust (the question comes first so you can walk away
   afterwards), then installs the pinned tools (Node, pnpm, gitleaks, actionlint, zizmor and
   cargo-deny, plus Rust if you said yes), then runs `pnpm install`, which also installs the git
   hooks (lefthook). The `INSTALL_RUST=yes|no` switch answers the Rust question in advance, for
   example `INSTALL_RUST=yes make setup`. Rust is a download of about 1 GB; without it the desktop
   shell can't build, and `make gate` reports `rust skipped`. Plain `mise install && pnpm install`
   also works, but `mise install` installs every tool in `mise.toml`, Rust included, without
   asking. `mise.toml` holds the pins and `mise.lock` their checksums.
10. **Verify.** `node --version` prints `v26.11.1`, and `make gate` runs every check and ends with
    `GATE PASS`. With Rust installed, the first `make gate` compiles about 400 crates and takes
    several minutes; later runs are fast. `make check` is the fast version for what you changed.
11. **Run it.** `pnpm dev` starts the daemon (http://127.0.0.1:4317) and the browser UI at
    http://localhost:1420, with state in `.dev/`. For the desktop window (needs Rust), leave
    `pnpm dev` running, run `pnpm --filter @10db/desktop sidecar` once, then run
    `pnpm --filter @10db/desktop dev:shell` in a second terminal. The window is "10db Dev"
    (identifier `app.10db.desktop.dev`) and keeps its data under `.dev/data`, so it runs
    beside an installed 10db without touching the release app's data. It uses the daemon and UI that
    `pnpm dev` already runs, so stopping `pnpm dev` stops them for the window too. The first
    `dev:shell` compiles the Rust shell and takes a few minutes. The installed app runs 10db's
    tasks; the dev window only previews your checkout.

    **Hot-reload the UI over your real 10db.** `pnpm dev:factory` serves your checkout's UI with
    live reload against the installed app's projects and Inbox:

    | When                             | Run                                                              |
    | -------------------------------- | ---------------------------------------------------------------- |
    | Once, and after each Mac restart | `pnpm dev:factory:enable`, then quit 10db (⌘Q) and open it again |
    | Every time                       | `pnpm dev:factory`, then open http://localhost:1420              |
    | To turn it off                   | `pnpm dev:factory:disable`, then quit and reopen 10db            |

    The gotchas and the desktop-window variant are in the README's
    [Hot-reload the UI over your real 10db](README.md#hot-reload-the-ui-over-your-real-10db).

12. **Optional tools.** [Claude Code](https://claude.com/claude-code) and the
    [Codex CLI](https://github.com/openai/codex) for AI-assisted work; both read the rules in
    `AGENTS.md`.
13. **Troubleshooting.**
    - A hook can't find a tool (`gitleaks: command not found`, `pnpm: command not found`): mise
      isn't activated in that shell. Redo step 7, or run `mise doctor`.
    - `mise` reports that `mise.toml` is not trusted: run `mise trust` in the repository root.
    - `ERR_PNPM_IGNORED_BUILDS` during `pnpm install`: a new dependency has an install script.
      Add an `allowBuilds` entry for it in `pnpm-workspace.yaml`, `true` only if the package needs
      its script to work.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject` (the `(scope)` is optional),
with a lowercase subject, for example `fix(daemon): close the database on shutdown`. The
`commit-msg` hook runs commitlint, and CI checks the pull request title the same way.

When a scope is given it comes from this list; the type is always required:

| Scope       | Covers                                                      |
| ----------- | ----------------------------------------------------------- |
| `daemon`    | `apps/daemon`                                               |
| `desktop`   | `apps/desktop`, including the Tauri shell                   |
| `contracts` | `packages/contracts`                                        |
| `db`        | `packages/db`                                               |
| `harness`   | `packages/harness`                                          |
| `repo`      | root config, tooling, scripts, agent rules and `tests/repo` |
| `ci`        | `.github/` workflows and settings                           |
| `docs`      | `docs/` and top-level Markdown                              |
| `deps`      | dependency updates                                          |

`.10db/pr-scopes.json` lists the same scopes, except `deps`, with the paths each covers, so 10db can scope the
pull requests it opens; a repo test keeps the two in step.

Trailers such as `Co-Authored-By:` are welcome.

Name every path you stage: `git add path/a path/b`, never `git add -A` or `git add .`. The
pre-commit hook runs gitleaks, Prettier, ESLint, `cargo fmt` and a hygiene check on the staged
files. Fix what it reports rather than skipping it; CI runs the same checks and blocks the merge.

## Pull requests

- Branch from `main` and open a pull request. Nobody pushes to `main`.
- Pull requests are squash-merged. The title becomes the commit on `main`, so it must be a valid
  Conventional Commit.
- Keep the squash dialog's commit subject as it is. GitHub fills it in from the title, which CI
  has checked, and lets whoever merges edit it; no rule can stop an edit there.
- Every required check must pass: `gate`, `desktop`, `policy`, `dependency-review` and
  `cargo-deny`. Resolve every conversation before merging. Nobody can bypass these, the
  maintainer included.
- While the maintainer is the only person with write access, no approval is required: nobody else
  can merge, and the required checks are the bar. The code-owner approval rule (`main-review`) is
  kept but switched off, and is switched on again when anyone else gets write access.
- The checks run from the pull request's own workflows, so a change to `.github/`, the hook and
  commit configs, `mise.toml` or the agent rules can change what is checked. Once others have
  write access the code-owner review covers that for them, and the maintainer reads those diffs in his own pull
  requests before merging.

## Signed commits

GitHub signs the squash merge on `main`, so signing your branch commits is optional but
encouraged. To sign with the SSH key you already use for GitHub:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Then add the same public key on GitHub as a **Signing key** (Settings, SSH and GPG keys).

## AI-assisted contributions

AI-assisted contributions are welcome. The person who opens the pull request is responsible for
all of it: they have read it, they understand it, and they can answer review questions about it.
Credit the tool with a trailer if you like, e.g. `Co-Authored-By:`.

## License

10db is licensed under Apache-2.0. Under section 5 of that license, any contribution you submit
is licensed under the same terms; no separate agreement is needed.
