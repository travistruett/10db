# Build process audit: the Sessions and trust build, 2026-11-12 to 2026-11-14

## Brief

**What happened.** The Sessions and trust build ran 52 hours from the first research agent to the stop. It used
about **$2,000 to $2,500 of tokens at list price** (78 transcripts across three orchestrator sessions) and landed
four of its planned pull requests. It was not slowed by thinking. It was slowed by waiting and by repeating work:

| Cause                                                                                    | Wall clock                                                                 | Tokens (list price)                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Agents blocked on a permission prompt that nobody was there to answer                    | **about 17 h on the critical path**; 24 h in all                           | ~$370 to $590 of orchestrator cache re-priming after the waits                             |
| The plan: 20 milestones, five of them security machinery (T2 to T6), executed as written | the trust line took 21 active hours against 11 for Sessions proper         | ~$620 for trust directly, plus most of the ~$460 mixed work; ~55 to 60% of subagent tokens |
| Contexts past the 550k rule (one at 944k)                                                | 7 mid-task handovers, each a cold reread of the plans                      | ~$350 to $450 for turns above 550k                                                         |
| Security findings fed back one per commit                                                | one class took 5 rounds in 12 minutes, another 6 to 7 rounds over 12 hours | small in tokens; 87 `fix` commits across #586, #592 and #615                               |
| Migration numbers renumbered four times, a fifth pending                                 | ~4 h of merge agents, plus 3.6 h stalled                                   | ~$60 to $80                                                                                |
| Mac load 20 to 40                                                                        | gates at 1,242 s; timing flakes and reruns                                 | not measured                                                                               |

**The biggest single cause was not on the original list.** Agents ran `cd <worktree> && git checkout -- <file>`,
the git guard answered `ask`, and the agent waited for a person. The guard lets a named-file discard through only
when the command's cwd is already the worktree, and a leading `cd` turns that off. Eighteen such waits cost 1,429
minutes of blocked tool time, including 9.3 hours overnight on the PR2 critical path. Nothing told the orchestrator.

**What changes for you.**

1. _(This PR, 10db rules.)_ Plans get a scope cut by you before a roadmap runs and a size cap. Findings are reported
   once per class. Implementer worktrees are removed as they merge. Migrations are numbered last.
2. _(This PR.)_ `.claude/claude-security-guidance.md` gives the security plugin's diff review 10db's threat model and
   tells it to report a class once, with every instance listed.
3. _(Proposed below, for your `~/.claude`.)_ Turn on auto-compaction, add a context-cap hook that stops an agent at
   400k, turn the plugin's per-turn review off for subagents, and add a worktree sweep to the coordinating-builds
   skill.
4. _(Board tasks.)_ Six product changes, the first being "an `ask` in an unattended run is a denial with a reason,
   never a wait".
5. _(Done today.)_ The disk went from 24 GB free to 135 GB free. Section 7 says what was removed and what keeps it
   from coming back.

**What could go wrong, and how we'd know.** Turning the plugin's Stop review off for subagents means a security
issue is first seen at the commit review or by the code reviewer. The commit review still runs on every commit, so
nothing goes unreviewed. A 400k cap stops some agents mid-task: each one must commit after every green step, and
the ledger shows whether handovers go up.

**Calls you might disagree with.** I left your `~/.claude/settings.json` as it is and wrote the diff here
instead. I added a worktree sweep and five rules to the coordinating-builds skill, since it is how every build is
run. The parts of this audit about your other repositories are outside the repo, beside the build's ledger.

**What I need from you.** Apply the `~/.claude` diff in section 6 (it affects every project), or tell me to.

---

The rest is for agents. Evidence is cited by file and line. "INFERRED" marks a conclusion drawn from evidence, not
read in it. Token figures are summed from the `message.usage` lines of the transcripts. Prices are Anthropic list
prices per million tokens: Opus 5.5 $4 in, $20 out, $0.20 cache read; Sonnet 5.5 $2, $10, $0.10; Fable 5.2 $8, $40,
$0.20. Cache writes are 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL, which gives the two ends of every
range. The build ran partly on Bedrock, whose prices differ, so the dollar figures are list-price equivalents, not a
bill.

## 1. The build in numbers

| Group                                | cache write | cache read | output | list price            |
| ------------------------------------ | ----------- | ---------- | ------ | --------------------- |
| Orchestrators, opus-5-5 (3 sessions) | 83.8M       | 403M       | 1.47M  | $529 to $780          |
| Subagents, opus-5-5                  | 44.2M       | 3,833M     | 11.82M | $1,224 to $1,357      |
| Subagents, fable-5-2 (26 reviews)    | 10.8M       | 86.6M      | 1.80M  | $197 to $262          |
| Subagents, sonnet-5-5                | 4.6M        | 380M       | 1.35M  | $63 to $70            |
| **Total**                            |             |            |        | **~$2,010 to $2,470** |

- The security plugin's own review cost is not in these figures. Its log rotates at 1 MB and kept only the last 5
  reviews ($0.91). The cost it caused shows up in the forward-and-fix loop (section 3.4), not in its own usage lines.
- Session 3's orchestrator ran 1,011 turns and peaked at 674k context. 166 of its turns each wrote more than 100k
  tokens to cache, 73.8M in all, which is 96% of its cache writes (INFERRED: the cache expired during long waits
  and every wake re-primed the whole context).
- Timeline (UTC): research and plans 11-12 17:13 to 18:35; T2 merged as #586 at 23:29; PR2 (M2a, M2b, T3, M2c) merged
  as #592 on 11-13 at 19:53 after a 9.3 h overnight stall; PR3a (#615) merged on 11-14 at 19:57 after two more
  stalls of 4.4 h and 2.7 h; stop at 21:37 with PR3b and M5b open.

## 2. How this audit was run

One session and two `researcher` subagents on Sonnet 5.5: one for the transcripts, ledger and PRs (214k tokens),
one for agent-os and 10db's lane code (129k tokens). No test suite was run. The raw tables are in the session
scratchpad: `transcripts.csv`, `all_agents.csv` (all 78 transcripts) and `asks.txt` (every hook `ask`).

## 3. Each cause, its evidence and what allowed it

### 3.1 Permission waits nobody could answer (the largest cause)

**Evidence.** `asks.txt` holds 18 PreToolUse `ask` decisions, all from `.claude/hooks/git-guard.mjs`, for
`git checkout -- <file>`, `git restore` and `git branch -D`. Seven lasted more than 20 minutes:

| Start (UTC) | Agent                      | Waited    | Command                                              |
| ----------- | -------------------------- | --------- | ---------------------------------------------------- |
| 11-13 06:06 | PR2 helper (sc-live-write) | 555.8 min | `git checkout -- <files>`                            |
| 11-13 15:28 | same helper                | 50.3 min  | `git checkout -- src/runner/runner.ts`               |
| 11-13 16:43 | orchestrator               | 28.4 min  | `git branch -D fix/sc-*`                             |
| 11-14 07:28 | M5a                        | 289.4 min | `git checkout -- drizzle/meta/_journal.json`         |
| 11-14 07:57 | T4 part B                  | 261.1 min | `git checkout -- self-update.test.ts`                |
| 11-14 12:58 | PR3a merge                 | 164.0 min | `git checkout merge/engine-main -- drizzle/meta/...` |
| 11-14 15:43 | PR3a merge                 | 46.3 min  | same                                                 |

The 11-13 06:06 wait held the PR2 critical path for 9.3 hours overnight. The 11-14 waits ended together when
you typed "still going?" at 12:19 UTC. Wall time lost on the critical path is about 17 hours (INFERRED from
overlapping waits). The "merge hung for 3.5 hours" in the hand-off was this cause, not drizzle-kit: the merge
agent's first command was answered with `permissionDecision: "ask"`.

**What allowed it.**

- The guard's discard exception holds "only when the command's cwd is in that worktree; `git -C <worktree>`, a `cd`
  or any other way of pointing git elsewhere turns it off" (root `AGENTS.md`, Git). Agents start almost every
  command with `cd <worktree> &&`, so the exception never applied. The same file says the guard _does_ follow a `cd`
  for a bare `git push`, so the code to follow it exists.
- An `ask` in a background subagent waits for a person with no timeout and no signal to the orchestrator.
  10db's own product rule is "a task that stops to wait on the builder is a bug", but the repository's tooling
  doesn't follow it.
- `stall-watch.sh` (coordinating-builds) watches worktree files. An agent blocked on a prompt changes no file, so
  it is reported only after 20 quiet minutes. The orchestrator was itself waiting on the agent, so it never saw
  that report.

**Enforce it mechanically.** An `ask` from the guard becomes a `deny` that carries its reason and a safe alternative
(`git show <ref>:<path> > <path>`) whenever the session is unattended. The discard exception follows a `cd`, as
push already does. Board task 1.

### 3.2 The plan was too big and was never cut against what you needed

**Evidence.**

- The roadmap ran 20 milestones (14 plans and 6 outlines; `2026-11-12-10db-sessions-roadmap.md`), with 175 plan
  tasks in 147,721 words of plans. T2 to T6 alone are 65,510 words and 74 tasks.
- All of T2 to T6 were planned in session 1, with ten plan reviews, before T2 was built (ledger lines 14 to 91). The
  roadmap's own rule was that later plans are written "once their predecessors have merged" (roadmap, header).
- T6 Tasks 0 to 4 were built and never merged (ledger line 368). T6 5 to 9, M6, M7 and M8 were cut.
- You cut the plan three times mid-run: 16 PRs to 9, then 4, then "lean mode" (ledger lines 126 to 139, 299 to 309).
  On 11-14 at 04:48 UTC you said "120 plan tasks sounds insane".
- Trust work took 21.2 active hours and $620 directly. Sessions proper took 11.3 active hours, about $360 at Opus
  rates. Mixed milestones took another 14.8 hours, about $460.

**What allowed it.**

- `coordinating-builds` asks once "how many pull requests", not "which of these milestones do you need for the
  goal".
- Superpowers' `writing-plans` checks scope only for "multiple independent subsystems".
- 10db's rules cap neither the size of a plan nor the number of milestones planned ahead. Plan review checks a plan
  against its spec, never the spec against the goal.

**Enforce it mechanically.** A roadmap has a "Builder's cut" table: each milestone is _needed for the goal_,
_later_ or _cut_, and the roadmap runs only the needed ones. Plans are written one milestone ahead. A `tests/repo`
rule test can check that each roadmap has the table and that no plan exists for a milestone two steps ahead of the
last merge. The rule is in `AGENTS.md` (this PR). The test is a follow-up.

### 3.3 Contexts past the 550k rule

**Evidence.** The rule sat in one hand-off line (`trust-sessions-handoff.md:26`). Eight agents passed it:

| Agent                | Peak | Turns over 550k |
| -------------------- | ---- | --------------- |
| Track B part 2       | 944k | 510             |
| Track B part 3       | 764k | 310             |
| PR2 implementer      | 631k | 129             |
| T2 implementer       | 608k | 66              |
| T5                   | 592k | 72              |
| Track B part 1       | 584k | 45              |
| M2a/M2b/T3           | 584k | 48              |
| M5a desktop (Sonnet) | 552k | 1               |

- Subagents spent 1,181 turns above 550k: 811M cache read, 2.8M cache write and 1.0M output, about $200. The
  orchestrator's own 210 turns above 550k add about $150 to $230.
- The cost per turn grows with context, since every turn rereads it. Seven handovers each cost a cold read of the
  plans (ledger line 268).

**What allowed it.**

- `~/.claude/settings.json` sets `"model": "opus[1m]"` and `"autoCompactEnabled": false`. With a 1M window and no
  compaction, nothing stops an agent before 1M.
- `coordinating-builds` says "Don't hand off because the context is long; the harness compacts it", which your
  settings turn off.
- Superpowers' subagent-driven-development (implementer reuse across five fix rounds) pushes the same way.

**Enforce it mechanically.** Turn on `autoCompactEnabled`, and add a `PostToolUse` hook that reads the transcript's
last usage line and, past 400k, returns a block telling the agent to commit, write its handover and stop
(section 6). 10db's own lanes need the same ceiling in the runner (Board task 2).

### 3.4 Security findings fed back one per commit

**Evidence.**

- The security-guidance plugin (2.0.20, `hooks/hooks.json`) runs an LLM review on every `Stop` and an agentic
  review on every `git commit` and `git push`. Each review wakes the agent with its findings (`asyncRewake`) and
  sees only the latest diff.
- Session 3's state file lists 47 findings, 27 of them parser-differential or bypass findings in five files. The
  ledger has 24 "Auto security review" entries.
- One class, sudo-spelling detection (`namesSudo`, `sudoReadings`), took five fix rounds in twelve minutes before a
  ruling stopped it ("further sudo-spelling findings this PR are acknowledged, not chased", ledger line 203).
- The class "an approved git or gh call runs outside the sandbox" took six or seven rounds over about twelve hours
  of PR2.
- #586, #592 and #615 carry 22, 31 and 34 `fix` commits.
- A batching rule was written in session 2 (ledger lines 112 to 117) and lapsed in session 3 (line 227). You
  complained again on 11-14 at 17:48 UTC: "Can you not do a better job batching these security runs?"

**What allowed it.**

- The plugin has no batching setting, and its reviewer sees one diff at a time. 10db had no
  `claude-security-guidance.md` (the plugin's log shows `FileNotFoundError` for it), so it had no threat model.
- `.claude/agents/code-reviewer.md` and your CLAUDE.md both list "a security issue" as blocking. A blocking finding
  overrides the two-round cap, so a stream of security findings never runs into the cap.

**Enforce it mechanically.**

- `ENABLE_STOP_REVIEW=0` for subagents. The plugin's README names this setting for multi-agent setups. The commit
  review still runs.
- A project `claude-security-guidance.md` that asks for one finding per class with every instance listed (this PR).
  The Stop review reads it; the commit review does not yet.
- The code reviewer groups findings by class (this PR).
- In 10db's product, scanner and review findings are grouped by root cause into one fix (Board task 3).

### 3.5 Reviewers re-reviewing fixes

Refuted as stated. All six plan reviews stopped at round 2, and the code reviews mostly held two rounds. PR2 had a
third "verify" pass. The repetition was the security loop in 3.4, not the reviewer rounds. The 26 Fable reviews cost
$197 to $262 in all.

### 3.6 Migration numbers raced other pull requests

**Evidence.**

- PR3a's migrations moved from 0069 to 0074, then 0069 to 0075, 0071 to 0077, 0073 to 0079 and 0075 to 0085 as
  #600, #608, #611 and #612 landed (ledger lines 263 to 369).
- #614 then took 0086 and 0087, so PR3b's pair must move again.
- The merge lanes cost about 4 hours and $60 to $80, plus the 3.6 h stalled merge.
- The stacked PR3a branched on 11-13 at 20:58 and landed on 11-14 at 19:57, 23 hours later.

**What allowed it.**

- Drizzle numbers migrations in sequence, and several sessions added migrations in parallel. "Whoever merges second
  renumbers" was agreed at 04:26 UTC on 11-14.
- 10db's own lanes already prevent this: the `migrations` hazard is claimed by one task at a time, and a base merge
  carries a branch's migrations after the base's (`delivery/migration-carry.ts`). This build ran outside 10db, by
  hand, so it had neither.

**Enforce it mechanically.** Generate a branch's migrations last, after its final merge of `main`. Allow only one
open pull request that adds a migration at a time (`AGENTS.md`, this PR). A `make precheck` check that refuses a
push whose new migration numbers already exist on `origin/main` is a cheap follow-up.

### 3.7 Machine load

**Evidence.**

- Load averages printed in transcripts reached 38.0/39.5/25.1 at 21:40 UTC on 11-13 and 30.8 at 12:19 on 11-14. The
  ledger also logs a load of 44.
- M1's `make gate` took 1,242 s. Pass-api tests hit their 64 s timeout under load.
- Seven sessions ran at once, including a test-speed session. No single measurement shows the "4x slower" figure.

**What allowed it.** Nothing caps sessions across projects. 10db's load guard holds new lanes only above 4x cores
for 5 minutes (`apps/daemon/src/load/guard.ts:89`). On this 10-core Mac that is a load of 40, which the night barely
reached. Board task 4.

### 3.8 Other causes found

- **An agent logged as dispatched was never launched** (ledger line 163). The brief was written and the Agent call
  was missed.
- **Duplicate work:** three agents ran the same docs-revise brief in session 1. A "full parity" ruling was reversed
  twice.
- **Cloud credential expiry:** two AWS SSO expiries killed agents (11-13 23:52 UTC, 11-14 20:41 UTC).
- **Disk:** 33 merged worktrees and their Rust targets were left behind (section 7).

## 4. Where a rule existed but nothing enforced it

| Rule (where it was written)                                                | What happened                                            | What enforces it                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hand off at 550k (`trust-sessions-handoff.md:26`)                          | 8 agents past it, one at 944k                            | `autoCompactEnabled` and a 400k context hook (section 6); a runner ceiling for lanes |
| At most two fix rounds (`code-reviewer.md`, CLAUDE.md)                     | security findings always "block", so rounds never capped | one finding per class; the plugin's Stop review off for subagents                    |
| Batch security findings (ledger lines 112 to 117)                          | lapsed in the next session                               | the policy file and the reviewer rule; product grouping                              |
| Write later plans once predecessors merge (roadmap header)                 | T3 to T6 planned before T2 built                         | the builder's cut table and a repo rule test                                         |
| Remove a worktree once its PR merges (`AGENTS.md`)                         | implementer worktrees never get a PR, so 33 stayed       | rule extended to integration merges; `worktree-sweep.sh`                             |
| "A task that stops to wait on the builder is a bug" (`AGENTS.md`, product) | the repo's own guard made agents wait 24 h               | `ask` becomes `deny` when unattended (Board task 1)                                  |
| Cap parallel agents to what the machine takes (coordinating-builds)        | load 30 to 40                                            | load-aware hold at a lower level (Board task 4)                                      |

## 5. Ranked prevention changes

Savings are for a build of this size, estimated from the evidence above.

### (a) Your Claude Code setup

1. **An `ask` never waits in an unattended run.** It has two parts:
   - the git-guard change: Board task 1, because the guard lives in this repo;
   - a check in `stall-watch.sh` that reads subagent transcripts, not files, and reports an agent whose last line is
     a tool call older than 5 minutes.

   Saves about 17 h of wall clock and $370 to $590 of cache re-priming.

2. **A hard context cap.** Turn on `autoCompactEnabled`, and add a 400k `PostToolUse` hook (section 6). Saves $350
   to $450, and the handovers become planned instead of forced.
3. **The security plugin in multi-agent runs.** Set `ENABLE_STOP_REVIEW=0` for subagents, and give each project a
   policy file asking for one finding per class. Saves most of the 87 fix commits' rounds, about 12 h on PR2's class
   alone.
4. **The coordinating-builds skill.** Five changes:
   - ask "which milestones does the goal need" before anything is planned;
   - plan one milestone ahead;
   - say "compaction is on, and the 400k hook stops you" instead of "the harness compacts it";
   - run `worktree-sweep.sh` after each merge;
   - one Codex lane at most while Claude lanes run.
5. **Superpowers' fix loop** allows five rounds per task; your CLAUDE.md overrides it with two, but only in prose.
   The override holds once the reviewer reports one finding per class and the hook caps context. No change to the
   plugin itself.

### (b) 10db's repo rules and plan templates (this PR)

1. A roadmap carries a "Builder's cut" table and runs only the milestones the goal needs. Plans are written one
   milestone ahead, and a plan stays under about 8,000 words.
2. Reviews report one finding per class, every instance listed. A class already reported doesn't send the work back
   again: its later instances go to the open batch.
3. Implementer worktrees are removed when their branch merges into the integration branch, not only at the PR. The
   read-only `.dev/data/tools` folder is made writable first.
4. A branch generates its migrations after its final merge of `main`. Only one open PR adds migrations at a time.
5. `.claude/claude-security-guidance.md`: 10db's threat model and the one-finding-per-class instruction.

### (c) 10db the product (Board tasks)

1. A lane never waits on a prompt:
   - the lane's own git and gh run with `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true` and `GH_PROMPT_DISABLED=1`, which
     today reach only the daemon's own calls (`sandbox/env-allowlist.ts`, `git/run.ts:30`);
   - a foreground command with no output for a set time is stopped and reported, as `background_hung` already does
     for background commands;
   - the repo guard's `ask` becomes `deny` when unattended.
2. A per-step token and context ceiling enforced by the runner, with a stop state and a handover. Today tokens are
   only recorded (`runner.ts:3402`).
3. Review and scanner findings are grouped by root cause into one fix task, so a class takes one round.
4. The load guard holds new lanes at 2x cores, and a lane cap applies across all projects, not only per project
   and per account.
5. For a large plan, plan approval asks which milestones the goal needs, at every rigor, not only Critical.
6. 10db watches free disk as it watches load. It sweeps its own merged worktrees and their build output, and holds
   new lanes below a free-space floor.

## 6. Proposed diff for `~/.claude` (not applied)

```diff
--- ~/.claude/settings.json
+++ ~/.claude/settings.json
-  "autoCompactEnabled": false,
+  "autoCompactEnabled": true,
+  "env": {
+    "GIT_TERMINAL_PROMPT": "0",
+    "GH_PROMPT_DISABLED": "1"
+  },
   "hooks": {
+    "PostToolUse": [
+      { "hooks": [ { "type": "command", "timeout": 5,
+        "command": "python3 -I ~/.claude/hooks/context-cap.py 400000" } ] }
+    ],
     "Stop": [
```

`~/.claude/hooks/context-cap.py` reads `transcript_path` from the hook input and takes the last assistant line's
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Past the limit it prints `{"decision":
"block", "reason": "Context is past 400k. Commit what is green, write your handover to the brief's report path,
and stop."}`. It sits in the main checkout's settings, so it covers the orchestrator and every subagent.

For the security plugin, put `ENABLE_STOP_REVIEW=0` in the environment the coordinator's subagents start with, or
set it in `env` above if you want the per-turn review off everywhere (the commit review stays on). Add the same
`GIT_EDITOR=true` only for unattended runs, since it changes interactive `git commit` without `-m`.

**Applied, since you asked today for the disk waste to stop across Claude Code and Codex:** `coordinating-builds`
has a new `worktree-sweep.sh` and five new rules: the builder's cut, a permission prompt counts as a stall, a 400k
context ceiling, remove worktrees as they merge, and group findings by class. It also dropped the line "the
harness compacts it". Codex reads the same files, because `~/.agents/skills/coordinating-builds` is a link to
`~/.claude/skills/coordinating-builds`. These edits add guidance and a script that only lists unless given
`--remove`. Revert them by deleting the script and the five bullets.

## 7. Disk: what piled up, and what keeps it from coming back

On the day of this audit the disk had 24 GB free. Clearing what was merged or dead brought it to 135 GB. The
10db share: 33 merged worktrees and four abandoned ones (about 19 GB), Rust `target/` folders (21 GB), and dead npm
and pnpm stores (15 GB). The rest was other projects' Docker data, written up outside the repo with the rest of
the private part of this audit.

**Why it piled up, and what stops it.**

1. _Implementer worktrees never get their own PR_, so "remove it once its PR merges" never fired. The rule now also
   covers a branch merged into the integration branch (`AGENTS.md`, this PR). The coordinating-builds skill has a
   `worktree-sweep.sh`. It lists every worktree that has no uncommitted change and whose tip is in a merged PR's
   head or in `origin/main`, and `--remove` removes them. 10db's own sweep (`delivery/worktree-sweep.ts`) covers only
   `~/.10db/worktrees`.
2. _A worktree's `.dev/data/tools` is read-only_, so `git worktree remove` and `rm -rf` fail part-way and leave a
   half-removed folder behind. The rule and the script make it writable first.
3. _Every worktree that builds the Tauri app has its own 1.3 to 3 GB Rust target._ Only slices that change
   `apps/desktop/src-tauri` build Rust. A shared `CARGO_TARGET_DIR` is the alternative, at the cost of builds
   queueing on cargo's lock.
4. _Staging copies made inside a container's `/tmp` are never removed_ unless the run that made them removes them.
   Any run that copies a source tree needs a `trap` that deletes the copy on exit, or a named volume it can wipe.
5. _Docker has no disk limit_ unless one is set in Docker Desktop, Settings › Resources.
6. _Nothing watches free disk._ Board task 6, and the sweep runs at each merge.

## 8. The builder's other repositories

The comparison with the agent workflow in the builder's other repositories is kept outside this repo, beside the
build's ledger. What carries over to 10db: a spawn cap and a review cap stated per size tier ("at most one bounded
implementer", "one bounded review, never two mechanisms over the same question"), and a picker that runs parallel
work only where the files it touches don't overlap.

## 9. 10db's own lanes against the same failure modes

| Failure mode           | 10db lanes today                                                                                             | Where                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Plan too big           | Critical plans wait for the builder's approval; nothing asks which milestones                                | `routing/playbook-defaults.ts:51`                                                   |
| Findings one at a time | review rounds converge; no grouping by class                                                                 | `contracts/src/review-rounds.ts:11`                                                 |
| Review round cap       | in code: Light 1, Standard 1, Careful 2, Critical 2                                                          | `routing/playbook-defaults.ts:39`                                                   |
| Context cap            | none for lanes; Shape has 70%                                                                                | `runner.ts:3402`, `shape/service.ts:283`                                            |
| Hang on input          | daemon git/gh never prompt; gates and background commands time out; a lane's own foreground command does not | `git/run.ts:30`, `github/gh.ts:264`, `runner.ts:367`, `sandbox/env-allowlist.ts:27` |
| Migration race         | claimed by one task at a time; carried over at landing                                                       | `delivery/migration-carry.ts`                                                       |
| Prompts while away     | answered at once, recorded as skipped                                                                        | `inbox/permission-broker.ts:266`                                                    |
| Load                   | holds new lanes above 4x cores for 5 min; default 2 lanes per project                                        | `load/guard.ts:89`, `scheduler/scheduler.ts:413`                                    |

10db the product already solves the migration race and the unattended prompt, the two things this hand-run build
suffered from most. Its gaps are a lane context ceiling, a foreground-command watchdog, grouping findings, the load
level and disk.

## 10. Calls made without asking

| Call                                                                                                                  | Cost if wrong                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Removed every merged, clean 10db worktree, plus the abandoned ones its owning session released                        | None found; each tip is in a merged PR's head                                    |
| Kept the local `feat/workbench-*` branches (each in #573's head, none with its own PR, so the guard asks before `-D`) | None; they take no space                                                         |
| Kept `remote-host-research`: six uncommitted docs not on `main`                                                       | None; commit or move them                                                        |
| `~/.claude/settings.json` changes written here, not applied                                                           | The causes in 3.1, 3.3 and 3.4 can repeat until they are applied                 |
| The guard change filed as a task, not made here                                                                       | The same: a guard change needs its red-first tests, which this audit doesn't run |
| Report figures are list-price equivalents                                                                             | The real bill differs on Bedrock and on a plan                                   |
