# apps/daemon/src/trust

- `trust/` builds each session's `TrustPolicy` (`@10db/contracts`): the four limits, whose prose lives in one
  place (`trust/limits.ts`), the environment the judge reads them in, and the coordination lines of its surface.
  The environment says whether Docker and loopback are open to the session (`DevAccess`; `sessionDevAccess` is
  the one rule every caller, a lane, a pass, a chat and the reporter, takes them from, so a chat that writes has
  Docker as its sandbox does) and, with Docker open, names the project's compose services, read by `folders/dev-services.ts` from
  `origin/<base>` only, never the lane-writable checkout (`decisions/2026-11-24-judges-know-the-projects-dev-containers.md`).
  `scripts/crosses-limit-replay.ts` replays the commands the judge skipped in the builder's own history, and controls, through the judge by hand.
- 10db's judge: `fast-path.ts` (`fastPathAllows`, `namesSecret`; its `JUDGED_OWN_TOOLS`, a chat's push, pull request and merge, are never fast) answers the calls that can't cross a limit
  with no model, a shell command only when every segment is in `read-allowlist.ts` (each read command with the
  only options it may carry, and its files regular, non-secret and inside the checkout or the temp dir, which the Read, LS, Glob and Grep tools meet too, and a path of theirs that starts with `~` or has leading or trailing whitespace goes to the judge, since Claude Code trims and expands it; a Glob runs `rg --files --null --glob <pattern> --sort=modified --no-ignore --hidden` in its search folder, which follows no link inside the tree, so only the search folder, the pattern's literal prefix and its syntax are checked (a `RIPGREP_CONFIG_PATH` is Claude Code's own environment, which the agent can't set); `ls` and `stat` never carry `-L`, which would follow a link inside the checkout out of it; `git log --stat` runs no textconv driver, since a diffstat counts lines of the stored blobs, and the driver's command could only come from the git config the agent can't write); `crosses-limit.ts` asks the `crosses_limit` decision the rest, with the call fenced as data, and
  reads `unsure`, a below-floor `allow` (there is no exception for a program in the checkout, committed or not: a rule keyed on files can't bound what the program then runs, since it imports, sources or launches session-written code; the judge's prompt says a checkout script runs inside the sandbox, so the model is the lever) and an input over `CALL_INPUT_MAX_CHARS` as a limit; `grants.ts` turns a
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
