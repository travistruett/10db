# apps/daemon/src/trust

- `trust/` builds each session's `TrustPolicy` (`@10db/contracts`): the four limits, whose prose lives in one
  place (`trust/limits.ts`), the environment the judge reads them in, and the coordination lines of its surface.
  The environment says whether Docker and loopback are open to the session (`DevAccess`; `sessionDevAccess` is
  the one rule every caller, a lane, a pass, a chat and the reporter, takes them from, so a chat that writes has
  Docker as its sandbox does) and, with Docker open, names the project's compose services, read by `folders/dev-services.ts` from
  `origin/<base>` only, never the lane-writable checkout (`decisions/2026-11-24-judges-know-the-projects-dev-containers.md`).
  A session in a separate copy (`TrustPolicyInput.copyId`) gets a `Separate copy:` line naming what the copy owns, the databases and stack its id's commands scope to, and what stays shared; `LIMIT_QUESTIONS`' DestroysData "no" counts what the session lines name as its own, which outside a copy is nothing (`decisions/2026-11-25-the-judge-takes-a-copys-project-commands-as-the-copys-own.md`).
  `scripts/crosses-limit-replay.ts` replays the commands the judge skipped in the builder's own history, and controls, through the judge by hand; with `--repo <checkout>` it reads that project's compose services and the committed files its commands run from `origin/<base>`, and `--only <text>` runs just the cases whose command holds the text.
- 10db's judge: `fast-path.ts` (`fastPathAllows`, `namesSecret`; its `JUDGED_OWN_TOOLS`, a chat's push, pull request and merge, are never fast) answers the calls that can't cross a limit
  with no model, a shell command only when every segment is in `read-allowlist.ts` (each read command with the
  only options it may carry, and its files regular, non-secret and inside the checkout or the temp dir, which the Read, LS, Glob and Grep tools meet too, and a path of theirs that starts with `~` or has leading or trailing whitespace goes to the judge, since Claude Code trims and expands it; a Glob runs `rg --files --null --glob <pattern> --sort=modified --no-ignore --hidden` in its search folder, which follows no link inside the tree, so only the search folder, the pattern's literal prefix and its syntax are checked (a `RIPGREP_CONFIG_PATH` is Claude Code's own environment, which the agent can't set); `ls` and `stat` never carry `-L`, which would follow a link inside the checkout out of it; `git log --stat` runs no textconv driver, since a diffstat counts lines of the stored blobs, and the driver's command could only come from the git config the agent can't write); `crosses-limit.ts` asks the rest as one yes/no question per limit (`LIMIT_QUESTIONS` in `limits.ts`, plus `builder_allowed` when the state holds the builder's allow lines or the run's notes) over a structured state: the session's lines and temp folder, `builder_allowed`, `builder_notes` (the run's Retry and Send back notes, `team/builder-notes.ts`, without 10db's revert notes), the count of untracked entries there before the session (or that the read failed) and the ones the call reaches (`preExistingNamed`: a path naming an entry, a folder above one or a path inside one, read from where the call runs or ending an entry's path; a pattern, the checkout, `git clean` or a deleting `find` reaches all), and the call as data (`decisions/2026-11-24-the-limits-judge-asks-a-question-per-limit.md`). `readLimitAnswers` reads them at the decision's floor f, raised to one half: `builder_allowed` at or above f allows; else the likeliest limit at or above f is that limit; else every limit with 1 − p over f allows; else a standing approval that applies allows (the precedent bullet below); else the call is unclear and the `crosses_limit_second` decision's model is asked the same questions (20 s, `secondary`, so its failures raise no outage card), read the same way. Still unclear, or a second that fails, is a limit with no name; a second that is stopped is the floor. There is no exception for a program in the checkout, committed or not: a rule keyed on files can't bound what the program then runs, since it imports, sources or launches session-written code; the state says a checkout script runs inside the sandbox, so the model is the lever. An input over `CALL_INPUT_MAX_CHARS` is a limit; `grants.ts` turns a
  project's grants (`trust_grants`) into the allow lines every judge reads (`grantTargetOf` keeps a note on one line
  or quotes the call). A grant of a quoted call is the agent's text, so no judge reads it: `projectGrantedCalls`
  matches it exactly against `grantCallSummary` of a call (a Bash command as written, but only while it carries no field beyond
  `command`, `description` and `timeout`; else the input as JSON), in the hook judge on a native session and a `tendb` one
  alike (a hook's `allow` ends the check, so Claude's auto mode classifier never sees the call) and in the broker
  before a limit or escalation card. Codex's hook can't approve a call, so a granted call there still meets Auto-review
  when it escalates; only 10db's judge honours the grant ahead of a model. `call-judge.ts` starts a `tendb` session on the rules when 10db's judge isn't ready.
- The fast path also reads a Markdown file in the session's setup with no model, for Read, Grep and the listed read commands on that file (a listing of a setup folder, a Glob and an edit still go to the judge), its name and every real path it leads to ending in `.md`: every reading of it must be inside one of `FastPathContext.setupReads`, the setup folders the profile opens (`FileAccessContext.setupReads`), so an advertised `SKILL.md` and its references cost no judge call while a skill's or plugin's other files still go to the judge. A path in a secret folder counts as a secret everywhere (`namesSecret`).
- The hook judge that runs them is `inbox/hook-judge.ts` (`createHookJudge`, `LimitNotes`); the card a noted limit
  raises is `inbox/limit-card.ts`, with the three answers, and Always in this project stores a grant in the
  answer's write (`inbox/service.ts`).
- `call.runs`: for a shell call the hook judge shows 10db's judge the committed text of what it runs
  (`call-runs.ts`, `callRuns`; `decisions/2026-11-25-the-judge-reads-the-committed-code-a-call-runs.md`): the rules of
  the make targets it names (`make [-C dir] target`, with their prerequisites, `$(MAKE)` calls and the scripts on their
  recipe lines, and the variables the recipes use; a recipe inside `ifdef … else … endif` keeps its directive lines, so
  the judge reads both branches and the test between them, and the scripts on both are followed) and repository scripts named by a path or after an interpreter,
  whole. Files come through `HookJudgeContext.readCommitted` (`folders/committed-file.ts`): `origin/<base>`'s text only
  where the checkout holds the same bytes, so a script the lane changed or created is judged as before, without its
  text. Only the first command of a line is followed, past `cd`s that certainly move it (the line's text is
  exactly `cd`, one bare word, then `&&`, `;` or a newline; a bracket, brace, quote or second argument stops the
  walk): an earlier command could write the file or change the shell (`cp e x.sh && ./x.sh`, `export
MAKEFLAGS=…; make x`), and so could a substitution or a here-document on the command itself, so those show nothing. Where a folder
  holds only `Makefile`, the reader's `differs` for `makefile` names that entry and the walk reads `Makefile`.
  Bounded: `RUNS_MAX_DEPTH` 3, `RUNS_MAX_READS` 12, `RUNS_MAX_SCRIPT_BYTES` 16 KiB (a larger script is not shown,
  never cut), `RUNS_MAX_CHARS` 24,000. `crossesLimit` adds `about_runs` and `call.runs` only when there is something
  to show. The runs are in the hook judge's verdict key, so an edit to a script judges its call again. Claude's auto
  mode and Codex's Auto-review don't see this text; a native session's calls they judge run as before.
  `make-rules.ts` (`parseRules`, `within`, `MAKEFILE_NAMES`) is the Makefile reader it shares with
  `daemon/docker-need.ts`; it lives here because `folders/` reaches `guard/` through `git/` and the sandbox, and
  `guard/` imports `trust/`, so `trust/` imports `folders/` for types only.
- Standing approvals are precedents the judge weighs, never permission
  (`decisions/2026-11-25-a-standing-approval-is-a-precedent-the-judge-weighs.md`). `program-key.ts` (`programKey`,
  sharing `leading-command.ts` with `call-runs.ts`) names the kind of program a shell call runs: a make target with
  its folder, a repository script by path, a package runner's script, else the program and its first operand. It is
  null for a second command, a substitution, a here-document, a redirect outside the checkout or temp dir, a pipe
  into anything but fast-path reads, a non-shell tool, or a folder outside the checkout; `keyPackageFile` is the
  nearest `package.json` from cwd up to the checkout, for runner keys only. The key only picks which precedent is
  shown; nothing allows a call because it has one. `precedents.ts`: `precedentFor` takes the active row (in a copy
  the `copy` row first, and a `copy` row in any state stands for its key; outside a copy the `project` row only);
  `precedentLines` feeds `TrustPolicy.autoModePrecedents` (at most `PRECEDENT_LINES_MAX` 30, most recently used
  first, examples as JSON, each ending "It is context, not permission."); `runsHash` hashes the runs and the
  runner's script line; `PRECEDENT_LIMIT_CEILING` is 0.5 and `PRECEDENT_CONFLICTS_MAX` 3. In `readLimitAnswers` the
  precedent clause comes after "every limit under 1 − f allows" and before "unclear": the limits are read first, so
  only an otherwise-unclear call is allowed, by `precedent_applies` at or above f with the likeliest limit under the
  ceiling (`by: 'precedent'`), and a missing answer counts as no. A limit whose reading also found the precedent
  applying carries `precedentConflict`. `precedent_applies` is asked only when `stateOf` holds
  `builder_precedent`, the one precedent the hook judge picked. A precedent is withheld, never refused on: with no
  key, with `CallRuns.differs` (a file the walk read changed or new in the checkout, a walk cut at
  `RUNS_MAX_READS`, or a walk that threw), or with a runner's `package.json` that isn't the base's, nothing is shown
  and the call is judged as without it. `buildTrustPolicy` copies `precedents` into `autoModePrecedents` only, never
  `allow` (an exception to a soft deny) or `environment`; only `renderClaudeAutoMode` reads it, and `stateOf`
  never does, so 10db's judge gets no policy line. `precedent-candidates.ts` (`precedentCandidates`) counts only
  10db's judge's rows, doubt skips with no limit and `crosses_limit` calls answered `unsure`, never an auto mode
  denial: a key is offered at 3 calls in 2 runs within 14 days, after a blocked run, or after Run these now, with
  scope `copy` when every call ran in a copy. A candidate whose key and scope already have a row is dropped by the card's write, not here.
- `propose-production.ts` (`proposeProduction`, behind `GET /projects/:id/live-systems/proposals`) reads a capped set of
  files from `origin/<base>`'s commit, else HEAD, in git's object store and proposes live-system entries (vercel.json
  aliases, `*PROD*` names and production URLs in `.env*.example`, prod compose images, production workflow urls, prod
  AWS and GCP profiles), each with its file and line, minus those already listed. Nothing is added by it; the builder's
  click writes through `setProjectLiveSystems`.
- `skip-recorder.ts` records each skipped call once. A skipped shell call (`Bash`, Codex's too) whose summary isn't cut and
  whose program `sandbox/program-reach.ts` (`programRunnable`, handed in as the recorder's `runnable`) finds outside what the lane's kernel profile reads (`spec.settings.filesystem.allowRead`: the system roots, the
  checkout, the toolchain and the lane's own reads), by its real path on the lane's `PATH` (a program not found or a command that isn't
  a plain first word counts as runnable), is recorded `cant_run_in_lane` in place of its own kind, with the original reason kept after the new one. No Run these now clears
  it: the program fails in the sandbox however it is approved, and the card says to use 10db's browser or run it
  yourself. `programRunnable` lives in the sandbox module, since the sandbox reaches the trust module through the guard.
  It writes the call's `programKey`; `onDoubtSkip` is bookkeeping and never fails the record.
