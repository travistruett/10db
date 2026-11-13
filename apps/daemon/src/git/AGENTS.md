# apps/daemon/src/git

- A push the remote's own server fails is not a divergence. `git/network.ts` `failureKind` reads git's stderr: a `non-fast-forward` or `fetch first` rejection is `rejected`; an HTTP 5xx, or a `[remote rejected]` whose reason is the server's own error (`fatal error in commit_refs_rules`, `internal error`, `unavailable`, …), is `server_error`. The shipper (`pushBranch` in `delivery/ship.ts`) pushes a `server_error` again at most twice, `limits.pushRetryWaitMs` (5 s, on the injected clock) apart, with no card between; if it still fails, `shipCards.pushServerError` quotes GitHub's reason and says nothing of commits the checkout lacks (failure `network`, Retry offered). Only `rejected` gets the reconcile-by-hand card (`pushRejected`). Any other `[remote rejected]` (GH013 repository rule violations, a protected-branch or pre-receive hook) is `declined`: `shipCards.pushDeclined` quotes the remote's reason, names a repository rule or hook, and claims no missing commits (failure `network`, no automatic retry).
- The variables that point git at a repository (`GIT_REPO_ENV_VARS` in `git/`: `GIT_DIR` and the
  rest of `git rev-parse --local-env-vars` except the config ones) are dropped wherever the daemon
  starts a process that may run git: `git/`'s own calls (fetch and push take theirs off the
  `NetworkCall` env), every `gh` call (gh runs in an empty dir with `-R`), the login shell capture,
  and the launcher's env (sessions and the gate). A daemon started from a git hook still acts on the
  repository it names. Git config variables (`GIT_CONFIG_COUNT` with its `KEY_n`/`VALUE_n`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG`) are kept: they name no repository, and a builder's
  profile may set them on purpose.
- `git/`'s own calls also set `GIT_OPTIONAL_LOCKS=0`, so a read such as `status` never refreshes
  the index under `index.lock`. With the lock held, a lane's commit running at the same moment
  fails with "index.lock: File exists".
- The daemon's git runs nothing from the checkout (lane sandbox spec D13, decision 129). Every call in
  `git/git.ts` reads no attributes (`GIT_ATTR_SOURCE` at the empty tree, `core.attributesFile=/dev/null`) and
  passes `NO_ATTRIBUTES` and `DAEMON_GIT_CONFIG` through `run.ts` (every `GIT_*` dropped but the config-file
  selectors, a 60 s timeout) or `network.ts`; `gh` gets the hook and fsmonitor config through
  `GIT_CONFIG_COUNT` (`withDaemonGitConfig`). `startDaemon` resolves one git from the fixed prefixes `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin` (never a `PATH`, which can lead with a lane-writable dir) with a behaviour probe, keeps the path it found it at (Homebrew's prefix link, which outlives a `brew upgrade` and its cleanup, where the Cellar path it points to doesn't), and refuses to start when none passes (`version.ts`, prefixes in `install-prefixes.ts`). gh comes from the same prefixes in the same order (`github/resolve-gh.ts`), resolved at start; every gh call runs that path with the resolved git's directory first on its `PATH`, and a missing gh fails each call as not installed. `DEVELOPER_DIR`, `SDKROOT` and `TOOLCHAINS`, which steer Xcode's `/usr/bin/git` shim per spawn, are dropped from every git call, the probe's included, and from gh (`XCODE_SELECTORS` in `run.ts`). `startDaemon` hands the resolved git and gh to the system check (`ResolvedTools`), which reports those; docker comes from the prefixes, then `~/.docker/bin`, never the login `PATH`; claude and codex are 10db's pinned copies, never the builder's installs. `runGit` requires `bin`, so every call runs that git, and once a checkout is pinned, with `GIT_DIR` and `GIT_WORK_TREE` set to the pin, which `pinned()` reads once per operation and passes down. The
  daemon never reads or writes a worktree file itself: `changedPaths` is `status --ignore-submodules=all` on a
  private index, `commit` is `git add -A` on a private `GIT_INDEX_FILE` ending in
  `update-ref --no-deref <branch> <new> <old>`, and a batch's branch is checked out, and the checkout switched back when the batch ends, with `read-tree -m -u`;
  HEAD is never moved by a commit. `mergeIntoBranch` brings a base into a worktree batch's branch the same
  way: `merge-tree --write-tree` (objects only, no attributes, so no merge driver; exit 1 is a conflict,
  read through `RunOptions.answerExitCodes`), `commit-tree` with the branch as first parent, signed as
  `commit` is, `read-tree -m -u` (after refusing for uncommitted changes and untracked files at paths it writes,
  and for anything git doesn't track at a path it adds or where an added path needs a directory: `changed`
  and `kept`), then the compare-and-swap `update-ref`; a base tree that asks
  for a filter is refused as a push would be. `mergedCommit` makes the same merge of two commits, unsigned,
  kept only at a ref under `refs/10db/`, touching no file, index or branch; `keptRefs` and
  `deleteKeptRef` list and delete only refs there. `commitsSince` and the commit's
  search for a retried operation follow first parents, so a merge's commits are never a task's. Fetches of
  one checkout run one at a time (their own lock, apart from commits). A non-empty `info/attributes` in the git dirs is refused. A
  checkout's pin (git dir and common dir by inode, origin's URLs; the stored id also holds the device number, which a comparison ignores because macOS renumbers the Data volume when it remounts it) is recorded at project
  registration and kept in `app_settings` (`daemon/checkout-pins.ts`, keyed by real path); a mismatch, a
  changed origin or a non-empty alternates file is a `GitTrustError`. Its card carries the state it found,
  and only the card's Trust answer re-pins, through `git.retrust(repo, candidate)`, which pins exactly that
  state and refuses anew if the checkout changed since, or with a card offering nothing if a git dir in it lies
  inside any registered checkout or a lane temp root; the same check runs when a checkout is first pinned. A dir at or
  under a registered checkout's own `.git` directory is exempt (its lane profile denies it), and a re-trust checks only
  dirs that differ from the current pin. `commit`, `mergeIntoBranch`, `switchNewBranch` and `switchBack` read the pin inside the checkout's lock. A batch start reads origin's push URL through
  `pinnedPushUrl`, which checks it against the pin, so an origin added or changed since registration raises the
  Origin card. A commit's branch is the batch's or `workstreams.branch`, pinned at the first
  session, never HEAD. Fetch and push name the pinned URLs, in the form `git/remote-url.ts` parses (a URL with
  userinfo or anything that doesn't parse cleanly is refused), refuse a local origin inside any registered
  checkout (`checkouts`) or a lane temp root (`laneRoots`), read as written or through a link, and check the
  local-config allowlist (`git/config-trust.ts`) as defense in depth. A config file counts as lane-writable when it lies in
  the git dirs, any registered checkout or a lane temp root, read as written or through a link (`laneWritableRoots`),
  so a global include into another project's checkout is refused and its programs are never used. They read config with the login env
  (`NetworkCall.env`) and re-emit the builder's credential helpers through `GIT_CONFIG_COUNT`, after an empty
  helper that resets the list. Every refusal reaches `onRefused` (`daemon/git-refusal.ts`),
  which raises one card per checkout, cause and found state. A new git call goes through `git()` in
  `git.ts`, so it reads no attributes; only `check-attr` for the filter refusal reads them, which runs nothing,
  with the same git and pinned git dir.
- `git/` also makes and removes worktrees (worktree mode): `addWorktree` (`update-ref`, `worktree add --no-checkout
--lock --reason '10db <batch id>'`, the pin, `read-tree -m -u`), `removeWorktree` (only a directory under the
  worktree root, locked with a `10db ` reason and listed by git; otherwise `WorktreeNotOursError`),
  `listWorktrees`, `worktreeChanges` (an orphan's uncommitted changes, only for a locked, listed entry whose git dir is a direct child of the pinned common dir's `worktrees` and whose `commondir` names it), `worktreeIgnoredFiles` (its git-ignored files outside directories the ignore rules match, under the same checks; a refusal of a listed, locked entry's git dir is marked `unreadable`), `pruneWorktrees`, `deleteBranchIfAt` (with the remote-tracking ref `origin/<branch>` in one ref transaction when given its tip, then the `branch.<branch>` config section, as `git branch -D` drops it), `trackingTip`, `branchInUse` (checked out, rebased or bisected in any worktree, the check switch-back makes) and `fileAt` (a file of a commit, through `ls-tree`). `path-entries.ts` holds `existsAsEntry` and `comparablePath`, and `checkout-pin.ts` the worktree pin key (`worktreePinKey`), for every module that needs them. A
  worktree's pin is made at creation, copies the main pin's URLs and is keyed by batch (`checkout_pin.<batch id>`);
  `createGit({ worktreeRoot })` refuses a path at or under the root with no pin as `GitTrustFailure.Unpinned`, and
  `projectAt` resolves a worktree path to its project so refusals raise the project's cards.
