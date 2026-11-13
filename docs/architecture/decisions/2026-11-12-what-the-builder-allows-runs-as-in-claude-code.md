# What the builder allows runs as in Claude Code: their allow rule wins over the deploy rule, and a pass asks before it commits, pushes, merges or reads `.env`

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md` (item 6, "when in
  doubt, do what Claude Code does", applied to the guard's rules that T3 hands to a judge), and the T3 plan's
  call 10 (`docs/superpowers/plans/2026-11-12-10db-trust-t3-policy-and-auto-mode.md`).

## Decision

1. **A deploy covered by the builder's allow rule runs.** When a project's allowed commands (or another allow
   rule of the session) cover every segment of a command that deploys or publishes, the guard's PreToolUse hook
   settles the call itself, under every judge: no classifier (which `classifyAllShell` would otherwise hand it
   to) and no card stands in its way. Every other guard rule still applies to the line first: git and gh, hazards,
   claims, `sudo` and the file-access rules. With no allow rule, a judge that runs decides (and may escalate to a
   card); on the `rules` floor a deploy is refused as before.

2. **In a pass, a Read of the checkout's `.env*` files asks the builder.** Where the builder is in the session, a
   Read of one of the checkout's own `.env*` files (a file, or a file in a `.env*` folder, whose real path is in the
   checkout) gets a card the builder can allow, as in Claude Code, instead of a refusal. Claude Code keeps its deny
   rule on the file, since its Grep and Glob honour only that rule, so the PreToolUse hook settles the Read through
   the broker, and an allowed Read runs on a copy of the file in a folder of the session's own that the kernel and
   the file-access judge close (`10db-read-<hex>` in the files root). A lane still refuses it. The kernel still
   denies `.env*` to commands, a Grep, Glob or LS over one is still refused, and a `.env*` link that leads out of
   the checkout stays a protected read. A key file in the checkout is no secret 10db lists, so its Read is left
   to the judge, whose reads-secrets limit is a soft deny in a pass that Allow this can clear. Credential stores
   outside the checkout (`~/.ssh`, the Keychain, account config) stay unreadable in every session, as decision item
   1 of the trust decision keeps them.

3. **In a pass, a plain commit, push or merge asks, then runs.** `git commit …`, `git push <remote> <branch>`,
   `git merge <branch>` or `gh pr merge [<number>]`, alone on its line with literal words (`guard/pass-git.ts`),
   gets one card (Allow once or Deny) instead of the guard's refusal. Once allowed, 10db runs that exact call
   (`git/run-as-builder.ts`) at the checkout's root, with `GIT_DIR` and `GIT_WORK_TREE` set to the checkout's own
   `.git` folder (a `.git` file, a link, or a git dir naming another common dir is refused), `core.fsmonitor` off,
   no attributes from the tree, prompts off, through the daemon's own git and gh, and with no account credential
   (`ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK` and the rest of `SECRET_VARIABLES`) in its environment. A
   commit or a merge runs inside the gate's sandbox, built from the lane profile: the hook runners it starts
   (lefthook, husky, pre-commit) read files a lane writes (`lefthook-local.yml`, `.husky/`, `node_modules/.bin`,
   lint configs, package scripts), so they run contained. The checkout and its `.git` folder are writable there,
   but not `.git/hooks`, `.git/config`, `config.worktree`, `.git/info`, `modules`, `worktrees`, the files that point
   git at another git dir, the remote-tracking refs, tags and packed refs, or the refs of `main` and the base branch
   unless one is the current branch, and the builder's global git config is readable for their identity. A push
   and a `gh pr merge` need the builder's credentials, so they run outside the sandbox with `core.hooksPath` at
   `/dev/null`: the repository's push hooks don't run for an approved push. The card says which. The agent's Bash
   call then prints what it printed and ends with its exit code (on Codex, whose hook can't rewrite a call, the
   hook's refusal carries what ran instead). Each call carries only options that read nothing outside the
   checkout (commit: `-m`/`--message`, `--no-edit`, `--allow-empty`, `-a`, `-q`, `--no-verify`, paths; merge:
   those for a merge and a branch name; push: `-u`, `-q`, `-v`, `-n`, `--no-verify`, `--follow-tags`; gh: the
   merge method, `--auto`, `--subject`, `--body`), a push names a remote the checkout's own
   `git remote` lists (checked when it runs, so a folder named like a remote is never the target), and every
   push destination is a plain branch name, `refs/heads/<name>`, `HEAD` or `@`. Still refused, with no card and a
   plain reason: a force push, `--mirror`, `--all`, a delete, a push to `main` or the base branch in any case (a
   push of the current branch is checked when it runs), `--amend`, a message, template or paths read from a file,
   a merge strategy, `gh pr merge --admin` or `--delete-branch` (it checks out the default branch, and a pass stays
   on its branch), a pull request named by URL or in another repository, git's own
   options (`-C`, `-c`), and every other spelling (a wrapper, a variable, a substitution, a redirection, a second
   command). Lanes are unchanged: coordination still refuses git and gh writes there.

## Why

- The builder's ruling on T3: "A deploy covered by a builder allow rule runs (the allow rule wins, as Claude
  Code)." In Claude Code an allow rule settles a matching call before auto mode's classifier; 10db's guard kept
  refusing what an allow rule would wave through, which made 10db stricter than Claude Code for an action the
  builder had approved in advance.
- An allow rule the builder typed is their go-ahead for the action. A lane can't write one: the allowed commands
  live in 10db's database, and a repo's `.claude/settings.json` never loads (R7).
- Turned down: leaving the call bare and letting the classifier judge it under `classifyAllShell`. The
  classifier would then refuse a deploy the builder allowed, which is the lockdown the trust line removes.
- The builder's ruling on T3: "In a pass, `.env` and key reads keep the soft-deny card. Make sure it is a card the
  builder can allow, not a hard refusal." A pass's `.env` read was refused three times over (Claude Code's deny
  rule, the guard and the broker), so no go-ahead could clear it. The Read tool runs in Claude Code's process, not
  in the kernel sandbox, so a card on it opens the file only for the call the builder allowed. Turning the deny
  rule into an `ask` rule was turned down: Grep runs ripgrep in Claude Code's process and honours deny rules
  only, so `Grep {path: ".", glob: ".env*", output_mode: "content"}` would print the file with no card.
- The spec's fuller design (trust line §2: attended sessions kernel-readable, with the limit line judging each
  read) needs the sandbox profile to differ by surface and its adversarial review; this keeps the profile as it is
  and opens only the Read tool, behind a card.
- The builder's ruling on T3: "In a pass, git/gh commit, push and merge ask, then run: the call gets a card with
  Allow this, as in Claude Code, and runs once allowed. Force-push and a push to `main` (or the default branch)
  stay refused." A pass's checkout keeps its git state write-denied to the kernel and its credentials closed, so
  the agent's own call could not run even after a go-ahead. 10db running the exact call the builder allowed keeps
  the sandbox as it is. The call's own words are the builder's, but the hooks a commit starts are not: their
  runners read files the agent wrote, so what they run is the agent's code. A commit and a merge therefore run
  inside the sandbox, and a push and a pull request merge, which need the credentials, run no hook at all.
- Turned down: running every allowed call outside the sandbox with the repository's hooks, as a terminal would.
  The hook runners read agent-writable files, so the agent's code would run as the builder with the session's
  account credentials.
- Turned down: letting the pass's sandbox run commands unsandboxed (`allowUnsandboxedCommands` with the broker
  setting `dangerouslyDisableSandbox`). It changes the profile for every command and runs the call with the
  lane's command environment (`GIT_CONFIG_GLOBAL=/dev/null`, an empty `XDG_CONFIG_HOME`), so a commit has no
  identity and gh no sign-in.
