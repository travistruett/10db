# 10db Trust T4, Unattended Never Waits: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Board task runs to its end without waiting on the builder:

- A call at a limit is skipped with a message and recorded.
- A question the agent would have asked is answered at once and recorded.
- Both are listed when the run ends, in one Inbox item, **Skipped while you were away**. Its **Run these now** starts
  an unattended follow-up with the approvable calls approved.
- A judge that stops a turn is answered by resuming the turn, at most twice.
- Every card a lane can still raise goes to a judge or becomes a skip: an escalated call, an unread hazard, a
  background loop, web, MCP, unknown tools, agent-written config, Docker while it is off, a new network host.
- Codex asks for a host with `request_host`.
- A checkout's `.env*` files are closed to unattended work. In attended work they are readable after a card, where a
  judge runs, unless the project's switch opens them.

**Architecture:**

- **Skips are records.** Each skipped call or answered question is a `skipped_actions` row (`@10db/db`) with a
  `SkipKind`, written through one daemon recorder (`trust/skip-recorder.ts`). It is fed from:
  - the guard's unattended answer (`guard/unattended.ts`);
  - the permission broker;
  - the lane's question tools;
  - auto mode's denials (T3's `judge_denied` event);
  - the host judge.
- **Nothing waits.** `GuardInput.attended` comes from the session's `TrustPolicy`. In an unattended lane, the guard
  answers its own `ask` at once, from a table over the ask's kind and the live judge. The broker never raises a
  waiting card for an unattended lane. Whatever reaches it is a skip or an answered question.
- **The end of a run** raises the Inbox item (`inbox/skipped-card.ts`). It is marked in `skip_listings`, so a crash or
  a retry neither loses it nor repeats it.
- **Run these now** inserts the follow-up in the answer's own write (`skip_follow_ups`). It starts it from the place a
  pure state table picks (`delivery/skip-follow-up.ts`):
  - it waits while the source's batch ships or another member still runs;
  - it joins an open batch whose members have all settled or failed;
  - it starts from the base once the source has landed;
  - otherwise it starts on the source's branch, in a batch linked by `follows_batch_id`.
- **Approval differs by kind.** The classifier's denials come back as allow lines (T3's `TrustPolicy.allow`). Guard
  and broker skips come back as call keys, matched exactly. A refused host is seeded into the follow-up's
  `run_hosts`. Docker, `.env`, editor config, rc files, hazards, safety checks and questions are listed but not
  approvable.
- **New hosts** go to 10db's judge (`judge/`, decision `network_host`) with labelled, agent-supplied context. Allowed
  and refused verdicts are both kept for the run in `run_hosts`, with a cap per run.
- **`.env*`** is a per-session sandbox input (`SecretsAccess`), fixed at start.

**Tech Stack:** TypeScript, zod 4.6.7, Drizzle on SQLite, `@anthropic-ai/claude-agent-sdk` 0.3.316 (Claude Code
2.1.302), Codex 0.167.0 app-server, srt, Vitest, Mantine 9, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`:

- §2: the `.env*` split, and the rules the sandbox keeps.
- §4: the `rules` floor ("anything it would have asked about is treated as `limit`, so it still never waits
  unattended").
- §5: Unattended, all of it.
- §9: Agents may read `.env` files.
- §10, §11, and §12 (the T4 row).

Decision: `docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`. Research:
`docs/architecture/research/2026-11-12-trust-line-research.md` §4 and "Live checks (2026-11-12)" L1 and L2.

## Starting point: T3 and M4b have merged

The roadmap's order is … → T3 → M2c → M3 and M4a → M4b → **T4** → T5. Task 0 checks each name below on `main`.

- **T3** (`2026-11-12-10db-trust-t3-policy-and-auto-mode.md`, "Names this plan defines"):
  - the policy: `LimitName`, `TrustSurface`, `TrustPolicy` (with `attended` and `allow`), `LIMITS`, `limitOfDenial`,
    `buildTrustPolicy`, `TrustPolicyInput`, `isAttended`, `coordinationLines`;
  - the judge and guard: `LiveJudge`, `createLiveJudge`, `JudgedRule`, `judgedRuleApplies`, `GuardInput.judge`;
  - `renderClaudeAutoMode`, which renders `policy.allow` as auto mode's `allow`;
  - the `judge_denied` `SessionEvent`, with `DeniedCall`;
  - T3 call 8: an unattended lane's denial is only logged.
- **M2a/M2b:**
  - the fake, in `sessions/fake-script.ts` and `fake-session.ts`; T3 added its `judge` and `judgeDenied` steps;
  - `AgentSessionCore`, `AgentAdapter.capabilities(account, model?)` and `JudgeKind`.
- **T2:** `TrustSwitches`, `TRUST_SWITCH_KEYS`, `TRUST_DEFAULTS`, `trustSwitchesFor`, `trust-rows.ts`,
  `project-trust-section.tsx`. T2 also loads `.claude/skills|agents|commands` from the session's checkout as cleaned
  copies.
- **M4b:** Plan runs on the explore engine in auto mode, attended (`policy.attended` true). Its sandbox still comes
  from `createLaneSandbox().forSession` with `readOnly: true`, in `daemon/shape-session-tools.ts` or wherever M4b
  moved it.
- **Today's code this plan changes** (read on c4da899; line numbers move):
  - `inbox/permission-broker.ts`:
    - `createPermissionBroker` `:251`;
    - `wait` `:272-293`: the lane enters `WAITING_HUMAN` and parks after `project.humanWaitMinutes`, default 10;
    - `askQuestions` `:295-323` and `askPermission` `:356-383`;
    - `judgeHost` `:433-491`: a host card that does not block;
    - `judgeBash`, `judgeRead`, `judgeEdit` `:504-608` (`judgeEdit` always asks), and `decide` `:614`.
  - `mcp/tools.ts:372-408`: `ask_human` calls `inbox.ask` and `observer.onWaitStart`.
  - `guard/pre-tool-use.ts`: `brokerAsk` `:117-167` and `judgePreToolUse` `:284-301`.
  - `guard/judge.ts`: `GuardVerdict` `:92` and `DEPLOY` `:102`.
  - `sandbox/file-access.ts`:
    - the `CLAUDE_PROTECTED_*` lists `:76-96`;
    - `judgeRead` `:283-298` (`secretFiles` → `protected`; asks outside the checkout, the read list and the doc
      roots);
    - `read` `:426`, `readAsk` `:446`, `writeAsk` `:458`.
  - `sandbox/profile.ts`: `:224` (`refuseSecretsOverNeeds`) and `:344-350` (`.env*` in `denyRead`).
  - `sandbox/lane-sandbox.ts`:
    - `forSession` `:245`;
    - `:306-311`: Docker is null when the project has it off;
    - `:388-394`: a `Read(//path)` rule in `disallowedTools` for each `.env*` file;
    - `:396-405`: the `Edit` and `Write` ask rules on the `CLAUDE_PROTECTED_*` paths.
  - `runner/runner.ts`:
    - `preToolUse` `:2369` and `canUseTool` `:2390`;
    - the event loop `:2534`, and `turn_complete` `:2729-2843` (one-shot nudges such as `st.resultNudged`);
    - `markDone` `:1041` and `fail` `:981`;
    - the `builder_review` wait `:3143-3165`.
  - `recovery/recover.ts:223-233`: start-up fails stranded workstreams.
  - `delivery/ci-fix.ts:139-170` (a batch linked to another on the same branch) and `delivery/worktree-cut.ts:165-204`.
  - `sessions/codex-session.ts:465,523` (`approvalPolicy: 'never'`), and `codex-lane-permissions.ts:122-135`: the
    host list, sent once at `thread/start` or `thread/resume`.
  - `permissions/network-hosts.ts`: `checkConcreteHost` `:123-139`, `allowNetworkHost` `:244`. And
    `permissions/found-hosts.ts` (`foundHostFile`).

## Names this plan defines

T5, M4c, M5a, M5b and T6 cite these. Each is produced by the task in brackets.

- **`@10db/contracts`:**
  - `skipped-actions.ts` (Task 1):
    - `SkipSource = { AutoMode: 'auto_mode', SafetyCheck: 'safety_check', Guard: 'guard', Broker: 'broker', HostJudge: 'host_judge', Question: 'question', TendbJudge: 'tendb_judge' } as const`.
      The last is reserved for T5.
    - `SkipKind`: one value per `AskKind`, plus `deploy`, `docker_off`, `secret_read`, `escalation`,
      `default_mode_card`, `hazard_card`, `classifier`, `safety_check`, `host` and `question`.
    - `Approval = { Intent: 'intent', Exact: 'exact', SeedHost: 'seed_host', None: 'none' } as const`.
    - `SKIP_SUMMARY_MAX = 500`.
    - `SkippedActionDto = { id, workstreamId, toolName, summary, kind, limit: LimitName | null, reason, source, approval, createdAt }`.
    - `RunHostDto = { id, workstreamId, host, verdict: 'allowed' | 'refused', command: string | null, reason: string | null, createdAt }`
      (Task 11).
  - `ids.ts`: `SkippedActionId` (prefix `skp`, Task 1), `SkipListingId` (prefix `skl`, Task 9) and `RunHostId`
    (prefix `rhs`, Task 11).
  - `PROTOCOL_VERSION`, bumped (Task 5).
  - `JudgeDecision.NetworkHost = 'network_host'` (Task 11).
  - `McpToolName.RequestHost = 'request_host'` (Task 12) and `McpToolName.ReportBlocked = 'report_blocked'` (Task 7).
  - `McpToolOutputs.ask_human.inboxId`: nullable (Task 5).
  - `TrustSwitches.envFiles: boolean`, default **false** (Task 14).
- **`@10db/db`:**
  - `store/skipped-actions.ts` (Task 2):
    - `recordSkip(ctx, input: SkipInput): SkippedActionId | null`;
    - `listSkipsForWorkstream(db, id, after?: SkippedActionId): SkippedActionDto[]`;
    - `approveSkips(ctx, followUp: TaskId, ids: readonly SkippedActionId[]): void`;
    - `approvedSkipsForTask(db, taskId): SkippedActionDto[]`, empty once the task is `DONE`;
    - `approvedCallKeys(db, taskId): string[]`.
  - `store/skip-listings.ts` (Task 9):
    - `markListed(ctx, workstreamId, through: SkippedActionId | null, inboxId: InboxItemId | null)`;
    - `lastListed(db, workstreamId): SkippedActionId | null | undefined`;
    - `unlistedEndedRuns(db): WorkstreamId[]`.
  - `store/skip-follow-ups.ts` (Task 10): `insertSkipFollowUp(ctx, input)`, `pendingSkipFollowUps(db)`,
    `markSkipFollowUpStarted(ctx, taskId)`, `skipFollowUpOf(db, sourceTaskId)`.
  - `store/run-hosts.ts` (Task 11): `recordRunHost(ctx, input): RunHostId | null`,
    `runHostVerdict(db, workstreamId, host): 'allowed' | 'refused' | null`, `countRunHosts(db, workstreamId)`,
    `listRunHosts(db, workstreamId)`, `judgedHostsForProject(db, projectId)`, `seedRunHosts(ctx, workstreamId, hosts)`.
- **`apps/daemon/src/guard/unattended.ts`** (Task 3):
  - `AskKind` and `UnattendedOutcome = { ToJudge: 'to_judge', Skip: 'skip', Allow: 'allow' } as const`;
  - `unattendedOutcome(kind: AskKind, judge: JudgeKind): UnattendedOutcome` and `limitOfAsk(kind): LimitName | null`;
  - `answerUnattended(input: UnattendedInput): UnattendedAnswer`.
  - `GuardVerdict`'s `ask` gains `kind: AskKind`. Its `deny` gains `rule?: JudgedRule | 'docker_off' | 'secret_read'`.
  - `GuardInput` gains `attended: boolean`, `approvedKeys: readonly string[]` and `dockerOn: boolean`.
- **`apps/daemon/src/trust/`:**
  - `call-summary.ts` (Task 1): `callSummary(toolName, input): { text: string; cut: boolean }` (moved out of T3's
    `claude-session.ts`), and `callKey(toolName, input, checkout): string`.
  - `skip.ts` (Task 1):
    - `skipMessage(limit, reason)` and `SKIP_RESUMES_MAX = 2`;
    - `TurnSkips` and `stoppedBySkip(turn: TurnSkips)`;
    - `approvalOf(kind: SkipKind): Approval`;
    - `ApprovedAction` and `approvedLine(a)`;
    - `AWAY_ANSWER`.
  - `skip-recorder.ts` (Task 4): `interface SkipRecorder { record(skip: RecordedSkip): void; seen(toolUseId: string | null): void; inTurn(): TurnSkips; nextTurn(): void }`,
    and `createSkipRecorder(deps, run)`.
  - `host-judge.ts` (Task 11): `judgeNewHost(deps, req: HostRequest): Promise<HostVerdict>`, `RUN_HOSTS_MAX = 20`.
  - `TrustPolicyInput.approved: readonly ApprovedAction[]` (Task 10).
- **`apps/daemon/src/inbox/skipped-card.ts`** (Task 9):
  - `SkippedChoice = { RunTheseNow: 'Run these now', Dismiss: 'Dismiss' } as const`;
  - `raiseSkippedCard(deps, workstreamId)`, `sweepUnlistedRuns(deps)` and `applySkippedChoice(ctx, item, answer)`;
  - `SKIPPED_DETAIL`.
- **`apps/daemon/src/delivery/skip-follow-up.ts`** (Task 10):
  - `followUpStart(source: SourceState): FollowUpStart`;
  - `startPendingSkipFollowUps(deps)`, which also runs after a restart.
- **`apps/daemon/src/sandbox/`** (Task 14):
  - `SecretsAccess = { Closed: 'closed', Open: 'open' } as const` and `LaneSessionInput.secrets`;
  - `secretsAccessFor(attended: boolean, envFiles: boolean, judge: JudgeKind): SecretsAccess`.
- **For T5:**
  - `tendb` takes `rules`' path everywhere in T4, and T5 flips its values.
  - T5 moves Codex and gateway Claude from the `rules` floor to 10db's judge (`crossesLimit`) through the PreToolUse
    hook, with Codex kept on `approvalPolicy: never`. Its denials are `tendb_judge` rows (kind `classifier`, approval
    `intent`), and its prompt reads `policy.allow`. No Auto-review path is planned.
  - T5 opens attended `.env*` on the judges it adds.

## Global Constraints

- **Rules:** root `AGENTS.md` (including "Trust the developer, contain the agent"), `apps/daemon/AGENTS.md` (the
  security rule, "Modules"), `apps/desktop/AGENTS.md`, `packages/contracts/AGENTS.md`, `packages/db/AGENTS.md`,
  `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **Branch:** `feat/trust-t4`, in its own worktree, after M4b merged:
  `git worktree add ../10db-worktrees/trust-t4 -b feat/trust-t4 origin/main`. Tasks run in order.
- **Step size:**
  - Concurrent state, the guard, the broker and the sandbox (Tasks 2–7, 11, 12 and 14) are taken in small red-first
    steps, one commit per behaviour.
  - Views and wiring (Tasks 8, 9, 10, 13 and 15) are one vertical slice each, run against the real daemon before review.
- **Commits** are Conventional Commits that name every path (`git add a b && git commit -m '...'`). They use a
  single-quoted `-m` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
  Each newly tested behaviour carries one value card in its commit; a new row in an existing table needs none.
- **Migrations are forward-only.** `v0.1.0` is tagged, so the second rule of `packages/db/AGENTS.md` applies, not the
  baseline regeneration **(call 20)**:
  - Each table is a new generated migration, `pnpm --filter @10db/db exec drizzle-kit generate --name <name>`,
    numbered after whatever `main` holds (M4a ends at `0067`). Never edit or regenerate one.
  - No column is named `limit` (it is a reserved word in hand-written SQL): it is `limit_name`.
- **Attended work is unchanged except the `.env*` split** (Task 14):
  - A pass keeps its cards, T3's Allow this and today's host card.
  - Every existing broker, guard and runner test for an attended or `default`-mode path stays green, unchanged.
  - Each `GuardInput` builder gains `attended`, `approvedKeys: []` and `dockerOn`, and nothing else.
- **The sandbox is the boundary:**
  - Task 14 changes the profile (reads of `.env*`), Task 6 changes a session's ask rules, and Tasks 11 and 12 change
    which hosts a run may reach.
  - Their tests start on the real thing: Seatbelt through srt, and the broker over a real store.
  - Task 17 is the adversarial review that `decisions/2026-10-29-sandbox-is-the-boundary.md` requires.
- **Provider parity.** Each task states its behaviour per provider. T4 runs on two judges:
  - `native`: Claude plan, API key or Bedrock, on a model auto mode runs;
  - `rules`: Claude gateway, a Claude session off auto mode, and Codex.

  `tendb` appears in no account's value until T5, and wherever T4 branches on the judge, **`tendb` takes `rules`'
  path**, so it fails closed until T5 flips its values **(call 23)**.
- **Not in T4:**
  - 10db's judge `crossesLimit`, Codex and gateway Claude on `tendb`, and grants from "Always in this project" (T5).
  - Attended cards for a judged call on Codex or 10db's judge (T5).
  - The gate's hosts and its Docker note, which are unchanged (spec §16).
- No AA numbers anywhere in the repo.

**Facts this plan rests on** (research, "Live checks (2026-11-12)", and T3's facts):

- **L2, the classifier.** Auto mode's denial reaches the model as an error tool result, and the run continues.
  - The stream carries `system/permission_denied` with `decision_reason_type: 'classifier'`, and a reason that **names
    no rule** ("it gave no explanation"). So `skipped_actions.limit_name` is nullable and the reason is kept as text.
  - Claude Code tells the model to "STOP and explain to the user". That is what ends a headless lane's turn early.
- **L2, the safety check.** A built-in denial (`decision_reason_type: 'safetyCheck'`, for an `rm -rf` of a
  pre-existing folder) says only a person may approve it, and the run continues. T3 emits `judge_denied` for
  `classifier` only.
- **L2, model refusals.** `system/model_refusal_fallback` ends a step with no permission event, so no skip list built
  from denials sees it.
- **Lanes' hosts.**
  - Claude Code's sandbox asks `canUseTool` with `SandboxNetworkAccess` for an unlisted host. The broker reads the
    project's host rules on every call, so a host allowed mid-session works on the next retry.
  - Codex gets its host list once, at `thread/start` or `thread/resume` (`permissions.lane.network.domains`). An
    unlisted host is blocked silently.
- **What the hook's answer does** (`sessions/claude-mapping.ts:205-224`). A guard `ask` sends the call to `canUseTool`,
  past the classifier. A bare `allow` (no `settled`) leaves the call to the permission mode. So on `native`, "goes to
  the judge" is a bare allow.
- **Where reads run.** The kernel bounds Bash. Read, Grep, Glob and LS run in Claude Code's own process, so for them
  the guard and the `Read` rules are the line (finding 2).
- **Project config.** Project hooks never run in a sandboxed session (`settingSources: []`, `claude-adapter.ts:314`).
  `.mcp.json` servers run only by an approved hash (`inbox/mcp-approval.ts`, `mcp_server_approvals`). No plan builds a
  hash approval for project hooks (spec §6's row); see "Unowned".

## Calls made in this plan

Each is marked **(call N)** where it is made.

1. **Unattended means `!policy.attended`:** lanes and their follow-ups. A pass and Plan are attended (T3's
   `isAttended`).
2. **Every guard `ask` in an unattended lane is answered at once**, by Task 3's table. Nothing reaches a waiting card.
3. **An unread hazard is a skip on every judge.** The skip says a plainly written command goes through the hazard
   rules. The spec sends it "to the judge", but on `native` that judge is the classifier, which knows nothing of
   claims.
4. **An endless background loop** goes to the classifier on `native`: T3's `Shared Mac` hard deny covers CPU load,
   and background jobs stop with the session. On `rules` it is a skip.
5. **A read outside the paths a lane reads without asking is a skip on every judge.** The skip tells the agent to read
   it with a Bash command, which the sandbox bounds. A Read runs in Claude Code's own process, where the kernel does
   not reach (finding 2).
6. **Agent-written config:**
   - `.claude/settings*.json`, `.claude/hooks`, `.mcp.json` and `.claude/skills|agents|commands` are written without a
     card in an unattended lane. Its session spec drops the `Edit` and `Write` ask rules on those paths.
   - None of them runs before approval: project hooks load in no sandboxed session, `.mcp.json` loads by approved
     hash, and T2 copies definitions cleaned.
   - `.vscode` and `.idea` are **skipped**. The builder's editor runs their tasks, and 10db can't hold that back.
   - A home rc file stays kernel-unwritable, and its ask is a skip.
   - If Claude Code's own safety check refuses a `.claude/` write (Task 0's live check), the skip is listed as
     "Claude Code refuses this write itself".
7. **Docker while the project has it off is a skip** in an unattended lane, when the guard reads a `docker`,
   `docker-compose` or `podman` command. Attended, the kernel refuses it as today.
8. **On the `rules` floor, the deploy refusal becomes a skip** in an unattended lane (limit `writes_live`), so a
   deploy is listed on every account kind. The floor's other refusals stay refusals, because the agent can write the
   command another way.
9. **`skipped_actions` keeps one row per `tool_use_id` in a run**, through `ON CONFLICT DO NOTHING`. A call the broker
   skipped and Claude Code then reports as denied is one row.
10. **A turn stopped by a skip** is one whose last call, by `tool_use_id` order, was skipped. The runner resumes it
    with that skip's message, at most `SKIP_RESUMES_MAX = 2` times per step, counted on the run's control object. It
    does not resume when a handoff was requested, when the step is held for background commands, or when a builder
    message is queued.
11. **`report_blocked`** is how a step says it couldn't do its job without a skipped call. It needs at least one skip
    in the run. The step fails, naming the reason and the skips. A blocked step raises both the failed card and the
    Inbox item.
12. **The Inbox item covers each run's ends:**
    - An item is raised when the run reaches `DONE` or `FAILED` with new skips, questions or written config. It lists
      only what no earlier item of the run listed.
    - `skip_listings` marks it in the flag's own write. A start-up sweep raises what a crash missed.
    - A run the builder cancelled raises none.
13. **The follow-up's start comes from a state table over the source batch and its pull request**, read when the
    follow-up starts, not when the button is pressed:
    - It waits while the batch is cutting or shipping, or while another member of an open batch still runs.
    - In an open batch whose members have all settled or failed, it joins that batch, with no Ship Anyway needed.
    - It starts from the base once the source has landed.
    - Otherwise it starts on the source's branch, in its own batch linked by `follows_batch_id`. That batch ships to
      the source's pull request and is never counted as a CI fix.

    While it is pending or running, Retry on the source is refused, naming it, and the other way round. A cancelled
    or removed follow-up is no longer pending.
14. **Each skip kind declares its approval** (`approvalOf`, finding 6):
    - `intent`: the classifier's denials, given back as allow lines with the summary quoted as JSON and cut at 300
      characters.
    - `exact`: guard and broker skips a person may clear, matched on a call key.
    - `seed_host`: refused hosts, put in the follow-up run's `run_hosts`.
    - `none`: Docker, `.env`, editor config, rc files, hazards, safety checks, questions, Monitor with no command and
      unread edit paths. The item names what clears each one instead.

    Run these now approves exactly the approvable rows the item listed.
15. **A new host is judged by 10db's judge on every account kind.** Neither native judge can be asked from
    `canUseTool`, so `judge/` gets a decision, `network_host`.
    - The question labels the agent's text as the agent's, and says the allow covers every later command in the run.
    - No key, the judge off, a timeout or an answer below the floor is a skip, saying what to do.
    - T5 may fold this decision into `crossesLimit`.
16. **Host verdicts are kept for the run** (every session of the workstream) in `run_hosts`, allowed and refused
    alike, so a refused host is never asked again in that run. A run judges at most `RUN_HOSTS_MAX = 20` hosts.
    Allowed and refused hosts are listed on the task and offered to keep in Settings › Network hosts.
17. **Attended hosts keep today's non-blocking card**, including a `request_host` from an attended session.
18. **Codex reaches an allowed host from its next session.** At the turn's end, the runner relaunches the step,
    resuming the thread (`thread/resume`) with the host in `permissions.lane`, and its first message says the host is
    reachable now. Whatever `turn/start` accepts, the plan doesn't depend on it.
19. **`.env*` and the switch:**
    - There is a new switch, `envFiles` ("Agents may read `.env` files"), off by default.
    - Attended on `native`: the files are open in the kernel, and the session's `Read` rules for them become ask
      rules (a card).
    - Attended on `rules`: they stay closed, and the refusal says so (parity, finding 12).
    - Unattended: closed, and a read the guard sees is a skip.
    - The switch opens them everywhere, without asking, from the next session.
20. **Migrations are forward-only** (above), although the brief expected a regenerated baseline: `v0.1.0` is tagged.
21. **An unattended lane's questions are answered at once** with `AWAY_ANSWER`: "The builder is away. Make the call
    yourself and say in your handoff what you decided and why." This covers `ask_human` and `AskUserQuestion`. The
    question is recorded (`SkipKind.Question`), listed under "Questions it would have asked", and never approvable.
22. **Written config is listed** in the Inbox item:
    - the paths of call 6;
    - `.vscode` and `.idea` written by a command;
    - mise config: `mise.toml`, `.mise.toml`, `mise.*.toml`, `.config/mise/**` and `.tool-versions`.

    When the run's changed paths can't be read, the item says so and still lists the skips.
23. **`tendb` takes `rules`' path until T5** (finding 20).

## Per provider, after T4, and what T5 changes

| | Claude plan, API, Bedrock (`native`) | Claude gateway, or off auto mode (`rules`) | Codex (`rules` in T4) |
| --- | --- | --- | --- |
| A call at a limit | auto mode denies; Task 6 records it | the guard's asks and its deploy refusal are skips | same as gateway, through `codex-guard.ts` |
| A remaining card | to the classifier or a skip (Task 3) | a skip | a skip |
| A claimed hazard command (`pnpm add`) | runs | the broker's hazard card is a skip; use `install_dependencies` (finding 21) | same as gateway |
| A question | answered at once, recorded | same | same |
| A turn stopped | resumed, at most twice (Task 7) | same | same |
| Approved calls | allow lines, read by intent | exact call key | exact; T5's judge reads them by intent |
| A new host | 10db's host judge, else a skip | same | `request_host` to the same judge, from the next session; a host it never asks for fails in the kernel, unlisted |
| `.env*`, attended | open, with a card | closed, and says so | closed, and says so |
| T5 changes | nothing here | `tendb`: `ToJudge` goes to `crossesLimit`, intent matching, `.env*` opens | `tendb` through the hook, as for gateway: `crossesLimit`, intent matching, `.env*` opens |

## Review Focus

1. **A wait left in an unattended lane.** Any path that still reaches `inbox.ask` or `WAITING_HUMAN`: an escalation, an
   unknown tool, a Monitor socket, a host, a question or a hazard card. Rows in Tasks 4 and 5, one per branch.
2. **An approved call that approves more than it named.** A summary an agent wrote to read as a rule, a newline,
   `$defaults`, a tail past the cut, a skip recorded after the item was raised, or one the item never showed. Rows in
   Tasks 1, 9 and 10, and attack 3 in Task 17.
3. **Run these now pressed twice, while the source ships, after it landed, after its branch was deleted, or before a
   crash.** One follow-up, from the right start, and never lost. Rows in Task 10.
4. **A `.env` read through a link, a hard link, a case-folded name, a Grep over the checkout, or `cat .env` in Bash**,
   in an unattended lane with the switch off. It is closed in the kernel, and listed where the guard sees the path.
   Rows in Task 14.
5. **A host the judge allowed for one run, reached by another run, or reached by a later command it was never asked
   about.** Kept per workstream, and the judge is told the allow covers the run. Rows in Task 11.

---

### Task 0: Check the starting point, and two live answers the plan rests on

- [ ] **Step 1: Find each name.** Run:

```bash
git grep -n "export const LimitName\|export const TrustPolicy\b\|allow: z.array" -- packages/contracts/src/trust-policy.ts
git grep -n "export function buildTrustPolicy\|export function createLiveJudge\|export function limitOfDenial" -- apps/daemon/src/trust
git grep -n "export const JudgedRule\|judge: JudgeKind" -- apps/daemon/src/guard
git grep -n "judge_denied\|interface DeniedCall" -- apps/daemon/src/sessions/types.ts
git grep -n "judgeDenied" -- apps/daemon/src/sessions/fake-script.ts
git grep -n "TRUST_SWITCH_KEYS" -- packages/contracts/src/trust.ts
git grep -n "ciFix\|patchBatch" -- apps/daemon/src/delivery/ci-fix.ts
```

  Expected: one hit for each. Where an earlier plan landed a name differently, use `main`'s in every task and say so in
  the PR body.

- [ ] **Step 2: Run three live checks by hand** (a Claude plan, the pinned Claude Code, a scratch repository, flags as
  research L2 ran them, `--permission-mode auto`). Record each answer in the research notes' "Live checks" section:
  - **(a) Does an allow line clear a rewritten call?**
    - Inline `autoMode.soft_deny` holds T3's `Writing To Live Systems` line, and `allow` holds one `approvedLine`
      for `bin/vercel deploy --prod`.
    - Ask for `./bin/vercel deploy --prod`.
    - If it is denied, Task 10's follow-up brief quotes each approved command and says to run it exactly as written.
  - **(b) Does Claude Code's own safety check refuse a `Write` to `.claude/settings.json`?** Run it with no ask rule
    on the path. If it refuses, Task 6 maps that denial's reason to "Claude Code refuses this write itself"
    (call 6).
  - **(c) Does a `Read(//abs/.env)` ask rule make Grep over the checkout ask, or leave the file out of its results?**
    Task 14 uses the answer.

  Nothing is committed in this task, apart from the research notes, in Task 16's docs commit.

---

### Task 1: The skip's words, the kinds, and one summary and key of a call

**Files:**

- Create: `packages/contracts/src/skipped-actions.ts` and `skipped-actions.test.ts`.
- Modify: `packages/contracts/src/ids.ts` (`SkippedAction: idSchema('skp', 'SkippedActionId')`), `index.ts`,
  `json-schema.ts` and `generated/*`.
- Create: `apps/daemon/src/trust/call-summary.ts`, `call-summary.test.ts`, `skip.ts` and `skip.test.ts`.
- Modify: `apps/daemon/src/trust/index.ts`.
- Modify: `apps/daemon/src/sessions/claude-session.ts`, so that T3's `DeniedCall.summary` uses `callSummary`.

**Interfaces:**

- **`callSummary(toolName, input)`** moves T3 Task 8's rule here and answers `{ text, cut }`:
  - a Bash or Monitor call: its `command`;
  - WebFetch: its `url`; WebSearch: its `query`;
  - an edit: its `file_path`;
  - `SandboxNetworkAccess`: its `host`;
  - anything else: `${toolName} ${JSON.stringify(input)}`.

  The text is cut at `SKIP_SUMMARY_MAX` with `…`, and `cut` says whether it was.
- **`callKey(toolName, input, checkout)`** is the hex SHA-256 of `toolName`, a NUL, and the canonical JSON (keys
  sorted) of the call's deciding fields, uncut, with every occurrence of `checkout` replaced by `<checkout>` (R2):
  - for a known tool, the fields `callSummary` reads (`command`, `url`, `query`, `file_path`, `host`), plus
    `run_in_background`;
  - for an unknown tool, the whole input.

  A follow-up's new worktree then matches. A changed `description` or `timeout` doesn't change the key, and a key
  never rests on a cut summary (finding 5).
- **`skipMessage(limit, reason)`** is this exact copy (spec §5):
  - With a limit: `Skipped: this would ${LIMIT_VERBS[limit]}. Carry on without it and say in your handoff what you skipped.`
  - Without one: `Skipped: ${reason} Carry on without it and say in your handoff what you skipped.`
  - `LIMIT_VERBS`:
    - `destroys_data`: `destroy data this session didn't create`
    - `sends_data_out`: `send data out`
    - `reads_secrets`: `read secrets`
    - `writes_live`: `write to a live system`
- **`AWAY_ANSWER`**, exact copy: `The builder is away. Make the call yourself and say in your handoff what you decided and why.`
- **`TurnSkips`** is `{ lastCallSkipped: boolean; last: { limit: LimitName | null; reason: string } | null; skips: number }`.
  `stoppedBySkip(t)` is `t.lastCallSkipped` **(call 10)**.
- **`approvalOf(kind)`** **(call 14)**:
  - `intent`: `classifier`.
  - `exact`: `escalation`, `default_mode_card`, `deploy`, `web_or_mcp`, `unknown_tool`, `monitor_socket`,
    `read_outside` and `endless_loop`.
  - `seed_host`: `host`.
  - `none`: `config_write`, `docker_off`, `secret_read`, `editor_config_write`, `home_rc_write`, `unread_hazard`,
    `hazard_card`, `monitor_no_command`, `unread_edit_path`, `safety_check` and `question`.
- **`ApprovedAction`** is `{ summary: string; reason: string; limit: LimitName | null; kind: SkipKind }`.
- **`approvedLine(a)`** is this exact copy, where `quoted = JSON.stringify(a.summary.slice(0, 300))`:
  `Approved By The Builder: the call ${quoted}, skipped earlier because ${JSON.stringify(a.reason.slice(0, 200))}. A call with the same intent is approved, however it is written.`

**Per provider:** one vocabulary for every provider. Claude's classifier writes its own denial text. `skipMessage` is
what the guard, the broker and the host judge send, and what the runner resumes a turn with.

- [ ] **Step 1: Write the failing tests.**
  - `skipped-actions.test.ts`:
    - `a null limit parses`
    - `an unknown kind fails`
  - `call-summary.test.ts`, a table:
    - `Bash names its command`
    - `WebFetch its url`
    - `a network request its host`
    - `an unknown tool its name and input`
    - `a 600-character command is cut at 500 and says so`
    - `two commands sharing 499 characters have different keys`
    - `the same call in another worktree has the same key`
    - `the same command with another description has the same key`
    - `the same command run in the background has another key`
    - `the same input under another tool name has a different key`
  - `skip.test.ts`:
    - `a limit names its verb`
    - `no limit carries the reason`
    - `the last call skipped stops the turn`
    - `a skip earlier in the turn does not`
    - `an approved line quotes a summary with a newline as one line`
    - `a summary holding "$defaults" stays inside the quotes`
    - `an approved line cuts the summary at 300`
    - plus a table over every `SkipKind` for `approvalOf`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run --project contracts packages/contracts/src/skipped-actions.test.ts && pnpm --filter @10db/daemon exec vitest run src/trust/call-summary.test.ts src/trust/skip.test.ts`
  Expected: FAIL, because the modules don't exist.
- [ ] **Step 3: Implement, move T3's summary into `callSummary`, and run `pnpm --filter @10db/contracts generate`.**
- [ ] **Step 4: Run them, then `src/sessions` whole, typecheck and lint.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/trust src/sessions && pnpm --filter @10db/contracts typecheck && pnpm --filter @10db/daemon typecheck && pnpm exec eslint --max-warnings=0 packages/contracts/src apps/daemon/src/trust`
  Expected: PASS, with T3's `judge_denied` rows unchanged.
- [ ] **Step 5: Commit** as `feat(daemon): the words of a skip, its kinds, and one summary and key of a call`, with
  this value card:
  `protects=one skip message per limit, each kind's approval, a call key a cut or another worktree can't fool, an
  approved line that stays one quoted line; fails_when=agent text breaks out of an allow line, or two calls sharing a
  prefix match; why_new=nothing skips today; no_claim=that any judge honours an allow line (Task 0, live)`.

---

### Task 2: `skipped_actions` and the approvals, in SQLite

**Files:**

- Modify: `packages/db/src/schema.ts` and `schema.test.ts`.
- Create: `packages/db/drizzle/<next>_skipped_actions.sql` and its snapshot (generated).
- Create: `packages/db/src/store/skipped-actions.ts` and `skipped-actions.test.ts`. Modify `packages/db/src/index.ts`.
- Modify: `packages/db/AGENTS.md`, adding one bullet: the tables, one row per `tool_use_id` in a run, approvals as a
  join table read only until the follow-up is done, and `limit_name`.

**Interfaces:**

- **`skipped_actions`** is an append-only record (`created_at` only):
  - Columns: `id` (`skp_`), `workstream_id` (FK, not null), `session_id` (FK, nullable), `tool_name`, `tool_use_id`
    (nullable), `call_key` (nullable), `summary`, `kind`, `limit_name` (nullable), `reason`, `source` and `created_at`.
  - A partial unique index, `skipped_actions_one_per_call`, on `(workstream_id, tool_use_id)` where
    `tool_use_id IS NOT NULL`, and an index on `workstream_id`.
- **`skip_approvals`** is a join table with no id or timestamps: `task_id` (FK, the follow-up) and `skipped_action_id`
  (FK). Its primary key is both.
- **`SkipInput`** is `{ workstreamId, sessionId, toolName, toolUseId, callKey, summary, kind, limit, reason, source }`.
- **`recordSkip`** inserts with `ON CONFLICT DO NOTHING` on the unique index **(call 9)**, and answers the new id, or
  null when nothing was written. Only when it writes, it appends `EventType.TaskChanged` for the run's task in the
  caller's write.
- **`listSkipsForWorkstream(db, id, after?)`** answers the run's skips oldest first, only those after `after` when it
  is given.
- **`approveSkips`** refuses an id from another project, or one whose `approvalOf(kind)` is `none`, with
  `ConflictError`, and then writes nothing.
- **`approvedSkipsForTask`** answers the rows approved for that task, oldest first, and `[]` once the task is `DONE`
  (finding 22). **`approvedCallKeys`** answers their `call_key`s.

**Per provider:** none; this is storage.

- [ ] **Step 1: Write the failing tests** (`createTestStore`):
  - `records a skip and lists it with its run`
  - `a second skip of the same tool use id in a run is not a second row and does not throw inside the caller's write`
    (the write's later statements still commit)
  - `the same tool use id in another run is its own row`
  - `skips with no tool use id are each kept`
  - `a written skip appends task.changed and an ignored one appends nothing`
  - `listing after an id answers only later skips`
  - `approvals list the approved rows for the follow-up only, and none once it is done`
  - `approving a skip of another project, or one that isn't approvable, is refused and writes nothing`
  - `schema.test.ts`: `skipped_actions keeps one row per call`, which checks that the index exists
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run --project db packages/db/src/store/skipped-actions.test.ts packages/db/src/schema.test.ts`
- [ ] **Step 3: Change the schema, generate the migration once, and implement the store.** Generate with
  `pnpm --filter @10db/db exec drizzle-kit generate --name skipped_actions`. If drizzle-kit writes a rebuild of an
  existing table, the schema change is wrong.
- [ ] **Step 4: Run them, then the db package whole and `make check-changed`.**
  Run: `pnpm exec vitest run --project db && make check-changed`
- [ ] **Step 5: Commit** as `feat(db): skipped calls, one row per call in a run, and their approvals`, with this value
  card:
  `protects=a skip recorded once per call without breaking the caller's write, approvals per follow-up that end when
  it is done; fails_when=a broker skip and Claude Code's denial of one call become two rows, or approvals outlive their
  follow-up; why_new=no table holds a skip; no_claim=who records them (Tasks 4, 5, 6)`.

---

### Task 3: The guard answers an unattended lane at once

The guard is a rule table. It gets exhaustive rows, every `AskKind` × every `JudgeKind`, in two commits.

**Files:**

- Create: `apps/daemon/src/guard/unattended.ts` and `unattended.test.ts`.
- Modify: `apps/daemon/src/guard/judge.ts` (`GuardVerdict`, `GuardInput`, and the answers of
  `FileAccessJudge.writeAsk` and `read`).
- Modify: `apps/daemon/src/guard/pre-tool-use.ts`:
  - `brokerAsk` returns `{ kind, reason }`;
  - T3's judged refusals carry `rule`;
  - the Docker check;
  - a secret refusal carries `rule: 'secret_read'`.
- Modify: `apps/daemon/src/guard/index.ts`.
- Modify: `apps/daemon/src/sandbox/file-access.ts` and `file-access.test.ts`:
  - `writeAsk` answers `{ kind, reason }`, by which `CLAUDE_PROTECTED_*` list matched;
  - `read` answers `{ refuse, secret: true }` for a checkout secret.
- Modify every `GuardInput` builder (`git grep -ln "judgePreToolUse\|judgeToolUse" apps/daemon/src apps/daemon/test`).
  Tests take `attended: true`, `approvedKeys: []` and `dockerOn: false` unless a row says otherwise; the runner sets
  them in Task 4.

**Interfaces:**

- **`AskKind`:**

  ```ts
  { WebOrMcp: 'web_or_mcp', UnknownTool: 'unknown_tool', MonitorSocket: 'monitor_socket',
    MonitorNoCommand: 'monitor_no_command', ReadOutside: 'read_outside', SecretRead: 'secret_read',
    ConfigWrite: 'config_write', EditorConfigWrite: 'editor_config_write', HomeRcWrite: 'home_rc_write',
    UnreadEditPath: 'unread_edit_path', EndlessLoop: 'endless_loop', UnreadHazard: 'unread_hazard' } as const
  ```

  - `brokerAsk` tags each of today's asks (`pre-tool-use.ts:117-167`).
  - `writeAsk`'s paths split into three kinds:
    - `ConfigWrite`: the three files and the `.claude/*` directories;
    - `EditorConfigWrite`: `.vscode` and `.idea`;
    - `HomeRcWrite`: the home rc files.
  - `SecretRead` is the attended ask of Task 14.
- **`unattendedOutcome(kind, judge)`** **(calls 3–6, 23)**:

| `AskKind` | `native` | `rules`, `tendb` | limit when skipped | reason copy when skipped |
| --- | --- | --- | --- | --- |
| `web_or_mcp` | `to_judge` (T3 already slims it) | `skip` | `sends_data_out` | — |
| `unknown_tool` | `to_judge` | `skip` | null | `${tool} isn't a tool 10db can judge for a task nobody is watching.` |
| `monitor_socket` | `to_judge` | `skip` | `sends_data_out` | — |
| `monitor_no_command` | `skip` | `skip` | null | `Monitor needs a command to run.` |
| `read_outside` | `skip` | `skip` | null | `${path} is outside what a task reads without asking. Read it with a Bash command, which the sandbox bounds.` |
| `secret_read` | `skip` | `skip` | `reads_secrets` | — (reached only attended; the exhaustive case) |
| `config_write` | `allow` | `allow` | — | — |
| `editor_config_write` | `skip` | `skip` | null | `${path} is editor config, which runs outside the sandbox when the builder opens the folder.` |
| `home_rc_write` | `skip` | `skip` | null | `${path} is outside the checkout.` |
| `unread_edit_path` | `skip` | `skip` | null | `The path of this edit could not be read; name it plainly.` |
| `endless_loop` | `to_judge` | `skip` | null | `This starts something in the background that never ends.` |
| `unread_hazard` | `skip` | `skip` | null | `10db can't read whether this changes a dependency or a migration this task hasn't claimed. Write the command out plainly, or claim the hazard first.` |

- **`UnattendedInput`** is `{ verdict: GuardVerdict; judge: JudgeKind; callKey: string; approvedKeys: readonly string[]; path: string | null; toolName: string }`.
- **`answerUnattended(input)`** answers `{ verdict: GuardVerdict; skip: { kind: SkipKind; limit; reason } | null }`:
  - **An `ask`** goes by `unattendedOutcome`:
    - `to_judge` and `allow` give a bare `{ decision: 'allow' }`;
    - `skip` gives a `deny` with `skipMessage(limit, reason)`, and the skip;
    - an ask whose kind `approvalOf` marks `exact` and whose `callKey` is in `approvedKeys` gives a bare allow, on
      every judge.
  - **A `deny` with `rule: 'deploy'`** on `rules` or `tendb` becomes the same deny, worded by
    `skipMessage('writes_live', …)`, with a skip of kind `deploy` **(call 8)**. A deploy whose key is approved gives a
    bare allow.
  - **A `deny` with `rule: 'docker_off'`** is worded by `skipMessage(null, 'Docker is off for this project. Turning it on is Settings › Project › Docker.')`,
    with a skip **(call 7)**.
  - **A `deny` with `rule: 'secret_read'`** is worded by `skipMessage('reads_secrets', …)`, with a skip of kind
    `secret_read` (finding 4).
  - Every other deny, and every `allow`, passes unchanged.
- **The Docker check** in `judgePreToolUse` runs only when `!input.attended && !input.dockerOn`. A Bash or Monitor
  command with a readable segment whose program is `docker`, `docker-compose` or `podman` is a `deny` with
  `rule: 'docker_off'`.
- The runner calls `answerUnattended` only when `!input.attended`. Attended verdicts are today's.

**Per provider:** the table reads only `judge`.

- Claude lanes on `native` send `to_judge` asks to auto mode's classifier.
- Gateway, off-auto Claude and Codex (`rules`) skip them.
- On Codex, a bare allow is an `allow` to `codex-guard.ts`, which runs the call in its sandbox.

- [ ] **Step 1: Write the failing table, asks half.**
  - In `unattended.test.ts`: every `AskKind` row above under all three `JudgeKind` values (36 rows, generated from one
    table), asserting the outcome, the limit and the reason.
  - Plus rows through `judgePreToolUse`, unattended, with a lane `fileAccess` built as `hook-asks.test.ts` builds one:
    - `a write to .claude/settings.json is config_write and allowed`
    - `a write to .vscode/tasks.json is a skip`
    - `a write to ~/.zshrc is a skip`
    - `WebFetch on rules is a skip`
    - `a Read of a home path on native is a skip, not the classifier's` (finding 2)
    - `"SUB=add; pnpm $SUB x" is a skip on every judge`
    - `"while :; do :; done &" goes to the classifier on native and is a skip on rules`
    - `an approved key for an unknown tool on rules is allowed`
    - `an approved key for an unread hazard is still a skip` (`none`)
- [ ] **Step 2: Run it to see it fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/guard/unattended.test.ts`
  Expected: FAIL, because the module and `AskKind` don't exist.
- [ ] **Step 3: Implement the asks half, then run the guard's whole suite unchanged.** That is `AskKind`, the tags,
  `unattendedOutcome`, and the `ask` half of `answerUnattended`.
  Run: `pnpm --filter @10db/daemon exec vitest run src/guard src/sandbox/file-access.test.ts && pnpm --filter @10db/daemon typecheck`
- [ ] **Step 4: Commit** as `feat(daemon): an unattended lane's guard asks are answered at once, by kind and judge`,
  with this value card:
  `protects=no guard ask waits in an unattended lane: each goes to the classifier, is allowed or is skipped by a
  table over every kind and judge, and reads outside the line are skips on every judge; fails_when=a kind falls
  through to a card, a Read outside the line reaches a judge the kernel doesn't back, or rules sends one to a judge
  that isn't there; why_new=asks carried no kind; no_claim=the broker never waits (Task 4)`.
- [ ] **Step 5: Write the failing rows, refusals half:**
  - `a deploy on rules unattended is a writes_live skip`
  - `a deploy on tendb is the same` (call 23)
  - `a deploy on rules with its key approved is allowed`
  - `a deploy on native passes as T3 left it`
  - `a pipe into a shell on rules stays a refusal`
  - `git push stays refused under every judge`
  - `docker ps with Docker off unattended is a skip naming the switch`
  - `docker ps with Docker on runs`
  - `podman run with Docker off is a skip`
  - `docker ps attended is not refused by the guard`
  - `a Read of .env unattended is a reads_secrets skip`
  - `a deploy beside a git push on rules is refused for the push` (the coordination refusal wins)
- [ ] **Step 6: Run them, implement the `deny` half and the Docker check, and run `src/guard` whole.** Then commit as
  `feat(daemon): the floor's deploy, docker while off and a closed .env read are skips in an unattended lane`, with
  this value card:
  `protects=a deploy, a docker call and a .env read in a task nobody watches are skipped and listed on every judge,
  while coordination refusals in the same line still win; fails_when=a deploy on the floor is refused without a
  listing, or a docker call fails silently in the kernel; why_new=the floor refused deploys unlisted and docker
  failed unseen; no_claim=what the classifier does with a deploy (T3's live row)`.

---

### Task 4: The broker never waits for an unattended lane, and every skip is recorded

This is concurrent state, in the broker and the runner's hooks. Small steps, three commits.

**Files:**

- Create: `apps/daemon/src/trust/skip-recorder.ts` and `skip-recorder.test.ts`.
- Modify: `apps/daemon/src/inbox/permission-broker.ts`. `createPermissionBroker` takes
  `{ attended: boolean; liveJudge: () => JudgeKind; approvedKeys: readonly string[]; checkout: string; skips: SkipRecorder }`.
  When unattended, `askPermission`, the cards of `judgeBash`, `judgeRead` and `judgeEdit`, and the unknown-tool branch
  of `decide` skip, instead of calling `deps.inbox.ask`.
- Modify: `apps/daemon/src/runner/runner.ts`:
  - `preToolUse` (`:2369`) builds `GuardInput` with `attended: spec.policy.attended`,
    `approvedKeys: approvedCallKeys(db, task.id)` and `dockerOn: project.docker`.
  - It calls `skips.seen(toolUseId)` for each call. When `!attended`, it applies `answerUnattended` and records the
    skip with the hook's `tool_use_id` and `callKey`.
  - `canUseTool` (`:2390`) passes the new broker deps.
- Modify: `apps/daemon/src/sessions/codex-guard.ts`, only if the hook's `tool_use_id` isn't carried to `preToolUse`
  today. If it isn't, add it to the hook input it already parses.
- Test: `apps/daemon/src/inbox/permission-broker.test.ts` (a new `describe('an unattended lane')`) and
  `runner/runner.test.ts`.

**Interfaces:**

- **`RecordedSkip`** is `{ toolName, toolUseId, callKey, summary, kind, limit, reason, source }`.
- **`createSkipRecorder({ state, log }, { workstreamId, sessionId, checkout })`:**
  - `record` writes `recordSkip` and logs `skipped a call` at info, with `{ toolName, kind, source }`.
  - `seen(toolUseId)` appends the id to the turn's order.
  - `inTurn()` answers `TurnSkips` for the calls since the last `nextTurn()`. `lastCallSkipped` is true when the last
    id in the turn's order has a skip recorded, whichever channel recorded it and in whatever order (finding 15). A
    question (`kind: 'question'`) never counts as a skip here.
- **The broker, unattended:**
  - A call that would reach a card, with no stored rule or one-time allowance, gets
    `{ behavior: 'deny', message: skipMessage(null, reason) }`. It is recorded with `source: 'broker'`, with this
    kind and reason copy:
    - `escalation`: `Auto mode sent this call to a person, and nobody is watching this task.`
    - `default_mode_card`: `This call needs a person's approval on this account, and nobody is watching this task.`
    - `hazard_card`: `This changes a dependency or a migration; use the install_dependencies tool, which runs it for the task.`
  - A call whose `callKey(toolName, input, checkout)` is in `approvedKeys`, and whose kind is `exact`, is allowed on
    every judge.
  - In `judgeEdit`, an edit whose path `fileAccess.writeAsk` tags `config_write` is allowed. On `rules`, default mode
    sends that write here, and call 6 lets it land.
  - It never calls `observer.onWaitStart`, so the workstream never enters `WAITING_HUMAN`.
  - `AskUserQuestion` is Task 5's, and `SandboxNetworkAccess` is Task 11's.

**Per provider:**

- Claude `native`: an escalation, and anything else Claude Code still sends to `canUseTool`, is a skip.
- Claude `rules` (default mode): every call no allow rule covers reaches the broker as today, and each card is a skip
  when unattended. That includes a claimed hazard command, which `judgeBash` cards (`:530-534`); the skip says to use
  `install_dependencies` (finding 21).
- Codex: the `ask` path of `codex-guard.ts` awaits the same broker, so it gets the same skip, and its denial body
  carries `skipMessage`.

- [ ] **Step 1: Write the failing recorder test** (`skip-recorder.test.ts`, real SQLite):
  - `records through the store and counts the turn`
  - `an allowed call seen after a skip clears lastCallSkipped`
  - `a denial recorded after the next call was seen does not make it the last` (out of order)
  - `a question doesn't count`
  - `nextTurn starts a new count`

  Run them, implement, run them again. **Commit** as `feat(daemon): one recorder for a run's skips, ordered by call`,
  with this value card:
  `protects=a run's skips written once and its last call judged by call order, not arrival order; fails_when=a late
  denial makes an earlier call look last, or a question stops a turn; why_new=nothing kept a turn's skips;
  no_claim=who feeds it (Steps 2-5)`.
- [ ] **Step 2: Write the failing broker rows.** Each runs on a real store and a real inbox service, one row per
  broker branch (Review Focus 1). Each asserts the decision, one `skipped_actions` row with its kind, no open Inbox
  item, and that `onWaitStart` was never called:
  - `an unknown tool is skipped`
  - `a classifier escalation is skipped`
  - `an escalation whose key is approved is allowed, on native too`
  - `a Bash call with an unread hazard is skipped`
  - `a claimed pnpm add on rules is skipped and names install_dependencies`
  - `a read outside the read list is skipped`
  - `an edit default mode would card is skipped`
  - `an unattended Write of .mcp.json on rules is allowed` (no row recorded)
  - `an unattended Write of .vscode/tasks.json on rules is skipped`
  - `a stored allow rule still allows`
  - `the same calls attended still raise their card` (one row per branch, with unchanged answers)
- [ ] **Step 3: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/inbox/permission-broker.test.ts -t "an unattended lane"`
- [ ] **Step 4: Implement the broker half, and run `src/inbox` whole.** Then commit as
  `feat(daemon): the permission broker skips instead of waiting for an unattended lane`, with this value card:
  `protects=no permission card or WAITING_HUMAN in an unattended lane on any judge; fails_when=a broker branch still
  asks the inbox for a lane with nobody there; why_new=every broker test is attended; no_claim=auto mode's own
  denials (Task 6)`.
- [ ] **Step 5: Write the failing runner rows**, in `describe('an unattended lane never waits')`, on the fake over the
  sandbox probe:
  - `a gateway lane's WebFetch is skipped and recorded, and the lane goes on to its handoff`
  - `a codex lane's unknown tool is skipped through its guard hook`
  - `a pass's WebFetch on rules still cards` (attended)

  Run them to see them fail, implement the `preToolUse` wiring, and run `src/runner` whole. **Commit** as
  `feat(daemon): lanes record what they skip`, with this value card:
  `protects=the guard's and the broker's skips reach skipped_actions from a lane on Claude and Codex, and a pass still
  cards; fails_when=a skip is answered but never recorded, or a pass loses its card; why_new=no runner row covers an
  unattended answer; no_claim=the Inbox item (Task 9)`.

---

### Task 5: An unattended lane's questions are answered at once

**Files:**

- Modify: `packages/contracts/src/mcp-tools.ts` (`ask_human`'s output `inboxId: InboxItemId.nullable()`, `:257`) and
  `generated/*`. Under `packages/contracts/AGENTS.md`, changes are additive, and removing or narrowing a field is a
  protocol change. A field a client could always rely on that may now be null narrows what it can rely on. So this
  task bumps `PROTOCOL_VERSION` and records the decision
  `docs/architecture/decisions/./2026-11-12-an-unattended-question-is-answered-at-once.md`, which says why the
  field became nullable and that `AWAY_ANSWER` is the answer.
- Modify: `apps/daemon/src/mcp/tools.ts:372-408`. For an unattended lane, `ask_human` records the question and answers
  at once with `AWAY_ANSWER`. It calls neither `inbox.ask` nor `observer.onWaitStart`.
- Modify: `apps/daemon/src/inbox/permission-broker.ts`. When unattended, `askQuestions` (`:295-323`) answers each
  question in `AskUserQuestion`'s answer shape, with `AWAY_ANSWER`, and records one row per question.
- Modify: `apps/daemon/src/briefing/prompts.ts`. For an unattended lane, every line that tells it to ask the builder
  (the `ask_human` lines) becomes: `Nobody is watching this task: a question gets "${AWAY_ANSWER}" at once. Decide yourself, and say in your handoff what you decided and why.`
- Test: the MCP tool test (`git grep -ln "ask_human" apps/daemon/test apps/daemon/src`), `permission-broker.test.ts`,
  `briefing.test.ts` and `runner/runner.test.ts`.

**Interfaces:**

- A question row is `{ kind: 'question', source: 'question', toolName: 'ask_human' | 'AskUserQuestion', toolUseId: null, summary: <the question, cut>, reason: 'The builder was away.', limit: null }`
  **(call 21)**.
  - One row per question.
  - `toolUseId` is null, so the one-row-per-call index never folds two questions of one `AskUserQuestion` call into
    one row (R3).

**Per provider:** every account kind. Codex reaches `ask_human` through 10db's `/mcp`.

- [ ] **Step 1: Write the failing rows:**
  - MCP: `an unattended ask_human answers at once with the away answer and records the question`, and
    `attended ask_human still asks`.
  - Broker:
    - `an unattended AskUserQuestion answers each question with the away answer and opens no item`
    - `two questions in one call are two rows`
  - Contracts: `ask_human's output takes a null inboxId`, and the protocol version test moves with the bump.
  - Runner: `a lane that asks a question reaches its handoff with no open Inbox item and never waits`.
  - Briefing: `an unattended lane is told questions are answered at once`, and `a pass keeps its ask line`.
- [ ] **Step 2: Run them to see them fail.** Then implement, run `src/mcp`, `src/inbox`, `src/briefing` and
  `src/runner`, and run `pnpm --filter @10db/contracts generate`.
- [ ] **Step 3: Commit** as `feat(daemon): a question in a task nobody watches is answered at once and listed`. Name
  the contracts paths and the decision file too. Use
  this value card:
  `protects=ask_human and AskUserQuestion never park an unattended lane, and each question is kept for the builder;
  fails_when=a question waits humanWaitMinutes and parks the lane; why_new=questions always waited; no_claim=that the
  agent's own call was right`.

---

### Task 6: Auto mode's denials in a lane are skips, and config writes land

**Files:**

- Modify: `apps/daemon/src/sessions/claude-session.ts`. The lane profile emits `judge_denied` for
  `decision_reason_type` `classifier` **and** `safetyCheck`.
- Modify: `apps/daemon/src/sessions/types.ts`: `DeniedCall.by: 'classifier' | 'safety_check'`.
- Modify: `apps/daemon/src/runner/runner.ts`:
  - An unattended lane's `judge_denied` is recorded as a skip, replacing T3 call 8's log line:
    - kind and source are `classifier`/`auto_mode`, or `safety_check`/`safety_check`;
    - `limit` is `call.limit`, and `reason` is `call.reason`. A safety check on a `config_write` path takes the reason
      `Claude Code refuses this write itself.` when Task 0 (b) found it does (call 6).
  - A pass offers Allow this for `classifier` only, as T3 does.
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts:396-405`. `LaneSessionInput.attended`: an unattended session's spec
  leaves out the `Edit` and `Write` ask rules on the `config_write` paths. The ask rules stay for `.vscode`, `.idea`
  and every attended session **(call 6)**.
- Modify: `apps/daemon/src/sessions/fake-script.ts`: `judgeDenied` takes an optional `by`.
- Test: `apps/daemon/src/sessions/claude-adapter.test.ts` (`describe('auto mode denials')`), `runner/runner.test.ts`
  and `sandbox/lane-sandbox.test.ts`.

**Per provider:** Claude plan, API and Bedrock emit the denials. Gateway and Codex emit no `judge_denied` in T4, and
their skips come from Tasks 3 and 4. The ask rules are Claude's. On Codex, `config_write` is the guard's allow alone.

- [ ] **Step 1: Write the failing rows.**
  - `claude-adapter.test.ts`: `a safetyCheck denial emits judge_denied by safety_check`, using L2's frame
    (`rm -rf "$(cat .cache-path)"`) and its reason text.
  - `runner.test.ts`:
    - `an unattended lane's classifier denial is one skipped_actions row with a null limit`
    - `a denial of a call the broker already skipped stays one row` (the same `toolUseId`, call 9)
    - `a pass's safetyCheck denial offers no Allow this`
    - `an unattended lane's Write of .mcp.json lands and is in the run's changed paths` (finding 3)
  - `lane-sandbox.test.ts`:
    - `an unattended session has no ask rule on .mcp.json or .claude/hooks`
    - `it keeps the ask rule on .vscode`
    - `an attended session keeps every ask rule`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-adapter.test.ts -t "auto mode denials" && pnpm --filter @10db/daemon exec vitest run src/runner/runner.test.ts -t "denial|Write of .mcp.json" && pnpm --filter @10db/daemon exec vitest run src/sandbox/lane-sandbox.test.ts -t "ask rule"`
- [ ] **Step 3: Implement, and run `src/sessions`, `src/sandbox` and `src/runner` whole.**
- [ ] **Step 4: Commit** as `feat(daemon): auto mode's denials in a lane are skips, and its config writes land`, with
  this value card:
  `protects=every classifier and safety-check denial in an unattended lane is listed once, and an unattended lane can
  write the config that runs only after approval; fails_when=a denial is only logged, the broker's skip and the
  denial of one call are two rows, or a config write still meets an ask rule and is skipped; why_new=T3 logged
  denials and every session asked on config; no_claim=denials the model never reaches (L2's model refusals)`.

---

### Task 7: A turn a skip stopped is resumed, at most twice; `report_blocked`; the briefing

This is concurrent state, in the runner's `turn_complete`. Two commits.

**Files:**

- Modify: `apps/daemon/src/runner/runner.ts`: `turn_complete` (`:2729-2843`), the run's `ctl.skipResumes` keyed by step,
  and the blocked step.
- Modify: `packages/contracts/src/mcp-tools.ts` (`ReportBlocked`, with input `{ reason: z.string().min(1).max(2000) }`
  and output `{ ok: z.boolean(), message: z.string() }`) and `generated/*`.
- Modify: `apps/daemon/src/mcp/tools.ts`: `TOOL_DESCRIPTIONS`, and a handler that sets the run's blocked reason through
  the runner's control, the way `write_handoff` reaches it.
- Modify: `apps/daemon/src/briefing/prompts.ts` (`PromptInput.attended`, plus T3's judged `AUTO_MODE_RULE` and the
  `rules` lines) and `briefing.test.ts`.
- Test: `apps/daemon/src/runner/runner.test.ts` and the MCP tool test.

**Interfaces:**

- **The resume.** In an unattended lane, at `turn_complete`, before the handoff rule:
  - When all of these hold, it sets `ctl.skipResumes[step] += 1` and sends `skipMessage(last.limit, last.reason)`
    with `handle.send`, then `break`s **(call 10)**:
    - `stoppedBySkip(skips.inTurn())`;
    - `(ctl.skipResumes[step] ?? 0) < SKIP_RESUMES_MAX`;
    - no outcome is set, and the run isn't parked;
    - `!st.handoffRequested` and `!st.heldForBackground`;
    - no builder message is queued in `createLaneMessages`.
  - Otherwise the turn's ending is today's.
  - `skips.nextTurn()` runs at every `turn_complete`.
  - `ctl` outlives a fresh session within the run. A daemon restart starts the count again, which bounds it to two
    per start.
  - An errored turn is not resumed in T4 (finding 16).
- **`report_blocked`:**
  - With at least one skip in the run (not counting questions), it marks the run blocked and answers
    `{ ok: true, message: 'The step will end failed when this turn ends.' }`. With none, it answers
    `{ ok: false, message: 'Nothing was skipped in this run; finish the step or hand off.' }` (finding 19).
  - In a pass or Plan, it answers `{ ok: false, message: 'report_blocked is for tasks nobody is watching.' }`.
  - At the turn's end, a blocked step fails with `fail(id, message)` and this exact message **(call 11)**:
    `The ${step.role} step couldn't do its job without a call 10db skipped: ${reason}. Skipped: ${summaries.join('; ')}`.
    The failed card and the Inbox item both follow.
- **The briefing.** Unattended, T3's judged `AUTO_MODE_RULE` loses its last sentence ("A dependency change and a loop
  with no end in the background wait on a card from the builder."), and gains this exact copy:
  `Nobody is watching this task. A call 10db or auto mode refuses with "Skipped:" is left out on purpose: carry on without it, and list each skipped call in your handoff. If the step's job can't be done without it, call report_blocked with the reason.`
  The `rules` floor's "wait on a card" line is replaced by the same copy. Attended lines are unchanged.

**Per provider:**

- Claude ends a turn on its own after a denial when it follows Claude Code's "STOP and explain" text.
- Codex in T4 ends one only by choice, because the guard's deny doesn't interrupt.

Both meet this rule. The briefing's copy is the same for every account kind.

- [ ] **Step 1: Write the failing rows**, in `describe('a turn a skip stopped')`, on the fake:
  - `a turn ending on a skip is resumed with the skip's message`
  - `a third stop ends the step as today` (two resumes, then `step_done`)
  - `the count survives a fresh session in the run`
  - `a turn that skipped and then ran a call ends as today`
  - `no resume when a handoff was requested`
  - `no resume while held for a background command`
  - `no resume when a builder message is queued`
  - `a stop or cancel at the same turn_complete sends nothing`
  - `a pass turn ending on a denial is not resumed`
- [ ] **Step 2: Run them to see them fail, implement, and run `src/runner` whole.** Then commit as
  `feat(daemon): a lane's turn that a skip stopped is resumed, at most twice`, with this value card:
  `protects=a step goes on past a judge's stop twice and then ends, and never resumes over a handoff, a background
  hold, a builder message or a stop; fails_when=a step ends at the first denial, resumes forever, or sends after it
  was stopped; why_new=the nudges cover a missing handoff and background commands only; no_claim=that the model does
  the rest of the work`.
- [ ] **Step 3: Write the failing rows for the rest:**
  - briefing: `an unattended judged lane is told what a skip is`, `an unattended rules lane is told the same`, and
    `a pass keeps its card line`;
  - MCP: `report_blocked with a skip marks the run blocked`, `report_blocked with none says so and changes nothing`,
    and `report_blocked in a pass does nothing`;
  - runner: `a blocked step fails naming the reason and its skips`.

  Run them, implement, and run `src/briefing`, `src/mcp` and `src/runner`. Run
  `pnpm --filter @10db/contracts generate`. **Commit** as
  `feat(daemon): lanes are told what a skip is, and a step can say it was blocked`, with this value card:
  `protects=an unattended lane learns that a skip is deliberate and how to fail a step it can't do; fails_when=a step
  fails with no skip behind it, or a lane is still told to wait on a card; why_new=the briefing promised cards;
  no_claim=that a model calls report_blocked when it should`.

---

### Task 8: Skips and hosts on the task

This is a vertical slice, run before review. It goes before the Inbox item, so the skips have a reader of their own
(finding 25).

**Files:**

- Modify: `apps/daemon/src/api/app.ts` and `api/services.ts`: `GET /workstreams/:id/skips` answers
  `SkippedActionDto[]`.
- Modify: `apps/desktop/src/daemon/queries.ts`, and the task detail view. The view gets one section, **Skipped while
  nobody was watching**, with each row's summary, its reason and when it happened. Questions sit under a
  **Questions it would have asked** subheading. The section shows only when there are rows.
- Test: the workstream routes' test file (`git grep -ln "/workstreams/:id" apps/daemon/test`), and the task view's
  test.

**Per provider:** the same for every account kind.

- [ ] **Step 1: Write the failing tests:**
  - route: `lists a run's skips oldest first`
  - view: `shows the skips and the questions apart`
  - view: `shows nothing with no rows`
- [ ] **Step 2: Run them to see them fail. Implement, run them, then typecheck, lint and knip.**
- [ ] **Step 3: Run it before review.** Run `pnpm dev` with the fake (`TENDB_FAKE_SCRIPTS`), using a task whose script
  emits `judgeDenied` and an `ask_human`. With `/browse`, see both on the task. No console errors.
- [ ] **Step 4: Commit** as `feat(desktop): a task shows what it skipped and what it would have asked`, with this value
  card:
  `protects=the builder can see a run's skips and questions on the task itself; fails_when=the route leaks another
  run's rows or the view mixes questions with skips; why_new=nothing read skipped_actions; no_claim=the Inbox item
  (Task 9)`.

---

### Task 9: Skipped while you were away

This is a vertical slice: the end of a run, a mark, the item, and a sweep after a restart. Run it before review.

**Files:**

- Modify: `packages/db/src/schema.ts`.
- Create: `packages/db/drizzle/<next>_skip_listings.sql` (generated), and `<next+1>_skip_listings_backfill.sql`
  (`drizzle-kit generate --custom`, written once by hand). The backfill inserts one listing row, with no item, for
  every workstream already `DONE` or `FAILED`, so the first start after the upgrade raises nothing for old runs.
- Create: `packages/db/src/store/skip-listings.ts` with its test.
- Modify: `packages/contracts/src/ids.ts`: `SkipListing: idSchema('skl', 'SkipListingId')` (R5).
- Modify: `packages/db/AGENTS.md`: extend Task 2's bullet with `skip_listings` and its backfill.
- Create: `apps/daemon/src/inbox/skipped-card.ts` and `skipped-card.test.ts`.
- Create: `apps/daemon/src/trust/written-config.ts` and `written-config.test.ts`.
- Modify: `apps/daemon/src/inbox/service.ts`, dispatching `applySkippedChoice` beside `applyDockerChoice`
  (`:676-681`).
- Modify: `apps/daemon/src/daemon/start.ts`:
  - a `WorkstreamChanged` subscriber, filtering as `delivery/trigger.ts:25` does, on `to` `DONE` or `FAILED`, calls
    `raiseSkippedCard`;
  - `sweepUnlistedRuns` runs once start-up recovery has finished.
- Modify: `apps/desktop/src/views/inbox/*` only if a flag's body renders without line breaks today. Check that with a
  render test first.
- Test: `apps/daemon/test/skipped-card.test.ts`, with a real store and real git for the changed paths.

**Interfaces:**

- **`skip_listings`** is append-only: `id` (`skl_`), `workstream_id`, `through_skip_id` (nullable), `inbox_item_id`
  (nullable: a run checked with nothing to say) and `created_at`.
  - `markListed` writes in the flag's own transaction, or alone when there was nothing to list.
  - `lastListed` answers the newest row's `through_skip_id`, or `undefined` when the run has no row.
  - `unlistedEndedRuns` answers the `DONE` or `FAILED` unattended runs with no listing row at all, which covers a
    run with only written config, and those with skips after their last listing.
- **`writtenConfig(paths)`** answers the paths of call 22 **(call 22)**.
- **`raiseSkippedCard({ state, inbox, git }, workstreamId)`** works only for an unattended run (the task isn't in a
  pass):
  - It reads `listSkipsForWorkstream(db, id, lastListed(db, id) ?? undefined)`, and the run's changed paths: the same
    diff the review step reads (`git grep -n "name-only" apps/daemon/src/git apps/daemon/src/delivery` names it).
  - Config is listed only on the run's first item.
  - When there is nothing new, it writes `markListed(ctx, id, through, null)`, so that a run is checked once.
  - Otherwise, in one write: `inbox.flag({ projectId, workstreamId, title, body, options, recommendation: null, detail: { [SKIPPED_DETAIL]: workstreamId, skipIds: <every approvable id shown> }, foldKey: `skipped:${workstreamId}:${through}` })`,
    then `markListed(ctx, workstreamId, through, item.id)` **(call 12)**.
  - The `title` is `Skipped while you were away: ${task.title}`.
  - The `body` is this exact copy, every row shown, no cap:
    - `10db skipped ${n} ${n === 1 ? 'call' : 'calls'} this task would have needed you for:`, then one line per
      approvable skip: `- ${summary} (${limit label or reason})`;
    - when there are any, `\nSkipped, and not something a follow-up can run:` then
      `- ${summary}: ${clearedBy(kind)}` per row. `clearedBy`:
      - `docker_off`: `turn Docker on in Settings › Project`
      - `secret_read`: `turn on Agents may read .env files`
      - `unread_hazard`, `hazard_card`: `write it plainly or claim it`
      - `editor_config_write`, `home_rc_write`: `make the change yourself`
      - `safety_check`: `only you can run it`
      - `monitor_no_command`, `unread_edit_path`: `the agent can write it another way`
    - when there are any, `\nQuestions it would have asked:` then `- ${summary}` each;
    - when config was written, `\nConfig this task wrote, which runs only after you approve it:` and `- ${path}`
      each. When the paths couldn't be read: `\n10db couldn't read which config files this task changed.`
  - The only option in this task is `Dismiss` (description `Leave the work as it is`). Task 10 adds Run these now.
- **`sweepUnlistedRuns(deps)`** calls `raiseSkippedCard` for each id of `unlistedEndedRuns`.
- **`applySkippedChoice(ctx, item, answer)`:** `Dismiss` resolves only.

**Per provider:** the same item for every account kind.

- [ ] **Step 1: Write the failing tests.**
  - `written-config.test.ts`, a table over paths:
    - `.mcp.json` yes, and `.claude/hooks/x.sh` yes
    - `.vscode/tasks.json` yes (written by a command)
    - `.config/mise/config.toml` yes
    - `src/a.ts` no
  - `skip-listings.test.ts` (real SQLite):
    - `the newest listing is the last`
    - `an ended run with skips after its listing is unlisted`
    - `an ended run with no listing row is unlisted`
    - `a run checked with nothing to say is not unlisted`
    - `the backfill marks every run that ended before it` (a migration test on a seeded database, as
      `database.test.ts` migrates its own)
  - `test/skipped-card.test.ts` (real store, inbox and git):
    - `a run with two skips raises one item with both`
    - `a run with none, no questions and no config raises none`
    - `a run that only asked questions raises an item listing them`
    - `a run that wrote .mcp.json lists it`
    - `the changed paths can't be read: the skips are listed and the item says so`
    - `a cancelled run raises none`, and `a pass raises none`
    - `twenty-five skips are all listed, and their ids are in the detail`
    - `failed, then retried, then done raises a second item with only the new skips` (finding 8)
    - `a restart between DONE and the item raises it once at start-up` (drop the subscriber's call, run the sweep)
    - `a run that only wrote config, missed by a restart, is raised by the sweep`
    - `recovery's FAILED at start-up raises the item once`
    - `the sweep after an item was raised raises nothing`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/trust/written-config.test.ts src/inbox/skipped-card.test.ts test/skipped-card.test.ts && pnpm exec vitest run --project db packages/db/src/store/skip-listings.test.ts`
- [ ] **Step 3: Generate the migrations, then implement, subscribe and sweep.** Generate with `--name skip_listings`,
  then `--custom --name skip_listings_backfill`, and write the backfill's SQL once.
- [ ] **Step 4: Run it before review**, as in Task 8, with a task that ends. Using `/browse`, see the Inbox item with
  its sections, and press Dismiss. No console errors.
- [ ] **Step 5: Commit** as `feat(daemon): one inbox item per run lists what a task skipped while you were away`, with
  this value card:
  `protects=every ended unattended run with something new to say raises exactly one item, after a crash, a recovery
  or a retry too, listing every row and what clears each; fails_when=an item is lost in a restart, raised twice for
  one listing, or hides a row behind a count; why_new=nothing listed skips; no_claim=the follow-up (Task 10)`.

---

### Task 10: Run these now starts an approved follow-up

This is a vertical slice through the real backend, with git. Run it before review.

**Files:**

- Modify: `packages/db/src/schema.ts`. Create `packages/db/drizzle/<next>_skip_follow_ups.sql` (generated) and
  `packages/db/src/store/skip-follow-ups.ts` with its test.
- Create: `apps/daemon/src/delivery/skip-follow-up.ts`, `skip-follow-up.test.ts` and `follow-up-start.ts` (the pure
  table).
- Modify: `apps/daemon/src/inbox/skipped-card.ts`: the `Run these now` option, and its answer.
- Modify: `apps/daemon/src/trust/policy.ts` and `policy.test.ts`: `TrustPolicyInput.approved`, with
  `allow: input.approved.filter((a) => a.kind === 'classifier').map(approvedLine)`.
- Modify: `apps/daemon/src/runner/runner.ts`, where a lane's `buildTrustPolicy` gets `approved` from
  `approvedSkipsForTask`.
- Modify: `apps/daemon/src/api/services.ts`. `retryWorkstream` refuses a source with a pending or running skip
  follow-up, naming it: `Retry waits for the follow-up "${title}": remove it, or let it finish.` Run these now refuses
  a source whose run is being retried (finding 7). A follow-up that was cancelled or removed is no longer pending.
- Modify: `apps/daemon/src/daemon/start.ts`, so that `startPendingSkipFollowUps` runs on every batch and workstream
  state change (the bus events `delivery/trigger.ts` reads) and once at start-up.
- Modify: `packages/db/src/schema.ts` (`batches.follows_batch_id`, nullable, in the same migration), and the
  delivery code that reads `ciFixOf` to choose a batch's branch and pull request
  (`git grep -n "ciFixOf" apps/daemon/src/delivery`). Those places read `followsBatchId` too. The places that stop on a
  failing check or count the fix budget read `ciFixOf` only (R4).
- Modify: `packages/db/AGENTS.md`, extending Task 2's bullet with `skip_follow_ups` (one row per follow-up, stamped
  once when it starts, pending only while its task is neither cancelled nor removed) and `batches.follows_batch_id`.
- Test: `apps/daemon/test/skip-follow-up.test.ts` (real git) and `e2e/skipped.spec.ts`.

**Interfaces:**

- **`skip_follow_ups`:** `task_id` (PK, the follow-up), `source_workstream_id`, `source_batch_id`, `started_at`
  (nullable) and `created_at`. A row is written once and stamped once, when it starts. `pendingSkipFollowUps` and
  `skipFollowUpOf` leave out a row whose task is cancelled or removed.
- **The option.** `Run these now` (description `Start a follow-up task that runs the calls above, approved`) is
  offered when the item's `skipIds` is non-empty. When `followUpStart` would answer `wait` at the time the item is
  raised, the description reads
  `Waits for the task to finish shipping, then starts a follow-up that runs the calls above, approved`.
- **`applySkippedChoice`, Run these now**, does everything in the answer's own write (finding 9):
  - It inserts the follow-up task with `insertTask`, with title `Run what "${source.title}" skipped`, the source's
    areas, and this description (exact copy):
    `The builder approved these calls, which an earlier run of "${source.title}" skipped. Run them, then finish what that run left undone because of them.`,
    then one line per approved skip: `` - `${summary}`: skipped because ${reason} ``. If Task 0 (a) found that an
    allow line does not clear a rewritten call, the copy adds: `Run each command exactly as written above.`
  - Then `approveSkips(ctx, newTask, item.detail.skipIds)`: exactly the ids the item listed (finding 5).
  - Then `insertSkipFollowUp`.
  - Only the start is queued after the write. A second press finds the item answered and does nothing.
  - Approved hosts are seeded when the follow-up's run starts, not here: the runner calls
    `seedRunHosts(ctx, workstreamId, <the host of each approved host skip>)` in the run's first write (R5).
- **`SourceState`** is
  `{ sourceRun: WorkstreamState; batch: BatchState; readiness: ShipReadiness; delivery: Delivery; pullRequest: PullRequestState | null; branchOnOrigin: boolean; pushed: boolean }`.
  - `readiness` is `shipReadiness` over the batch's members (`latestPerTask`). A batch with a `FAILED` member stays
    `OPEN` (`ship_anyway`); a `FAILED` batch means only that its ship failed (`delivery/ship.ts:511`).
- **`followUpStart(source)`** answers `wait`, `join`, `base` or `branch` **(call 13)**:

| Source batch | Members (`readiness`) | Pull request | Branch on origin | Start |
| --- | --- | --- | --- | --- |
| `CUTTING`, `SHIPPING` | any | any | any | `wait` |
| `OPEN` | `blocked` (a member still runs, queues, waits or is paused) | — | — | `wait` |
| `OPEN` | `ready` or `ship_anyway` | — | — | `join`: a new member of the same batch, in its worktree and on its branch |
| `SHIPPED` | — | `merged` | any | `base` |
| `SHIPPED` | — | `open`, `closed`, `unknown` | yes | `branch` (a linked batch) |
| `SHIPPED`, local delivery | — | — | any | `base` (landed) |
| `CLOSED` | — | any | any | `base` |
| `FAILED` (the ship failed) | — | not `merged` | yes | `branch` (a linked batch) |
| `FAILED` | — | `merged` | any | `base` |
| `ABANDONED` | — | any | any | `base`, and the description says the source's work was abandoned |
| a `branch` row, pushed | — | — | no | `base`, and the description says `The source's branch is gone; this follow-up starts from the base.` |
| a `branch` row, never pushed | — | — | no | `base`, and the description says `The source's work was never pushed, so it isn't on the base this follow-up starts from.` |

- **`startPendingSkipFollowUps(deps)`** takes each pending row and reads `SourceState` fresh, so a pull request merged
  between the press and the cut starts from the base:
  - `wait`: nothing happens.
  - `join`: the follow-up starts as a new member of the source's batch, the way a task added to an open batch starts
    in it (`git grep -n "batchId" apps/daemon/src/delivery/start.ts` names the path). No Ship Anyway is needed for
    it to start.
  - `base`: an ordinary batch, then `startTask`.
  - `branch`: a new batch on the source's branch (`insertBatch` and `patchBatch({ branch })`, as `ci-fix.ts:139-170`
    starts one), with `follows_batch_id` set to the source batch, not `ciFixOf`. It ships to the same branch and pull
    request as the source, never a second one. A failing check on its push raises no CI-fix stop and uses no fix
    budget. Then `startTask`.

  It then calls `markSkipFollowUpStarted`.
- **`buildTrustPolicy`:** `allow` holds one `approvedLine` per approved `classifier` skip. T3's renderer already puts
  `allow` after `"$defaults"` in auto mode's `allow`. Approved `exact` skips reach the guard and the broker through
  `approvedCallKeys` (Tasks 3 and 4).
- The follow-up is an ordinary unattended lane, so Tasks 3 to 9 apply to it.

**Per provider:**

- Claude `native` reads the allow lines (by intent) and the exact keys.
- `rules` and `tendb` match exact keys only.
- Codex in T4 is `rules`. T5 moves it to 10db's judge, whose prompt reads `policy.allow`.
- On every kind, the brief's own words are the builder's request.

- [ ] **Step 1: Write the failing tests.**
  - `skip-follow-up.test.ts`: the `followUpStart` table, one row per line above.
  - `skip-follow-ups.test.ts` (real SQLite): `a pending follow-up lists until it is stamped`.
  - `policy.test.ts`:
    - `approved classifier skips become allow lines, quoted`
    - `a summary with "$defaults" and a newline stays one quoted line` (Review Focus 2)
    - `an exact skip makes no allow line`
  - `test/skip-follow-up.test.ts`. It uses real git, with maintenance off as the testing rules require. Each
    `branch` row goes on to ship the follow-up:
    - `while another member of the source's batch runs it waits, and joins the batch once every member settled or
      failed`
    - `a blocked step's run, alone in its batch: run these now starts without Ship Anyway`
    - `while it ships it waits, and after it merged starts from base`
    - `a ship that failed with its pull request open: a linked batch on the branch, shipped as one`
    - `a failing check on the follow-up's push raises no CI-fix stop and uses no fix budget`
    - `a pull request merged between the press and the cut starts from base`
    - `the branch is gone: base, and said so`
    - `a branch never pushed: base, and the description says the source's work isn't on it`
    - `pressed twice, one task`
    - `the follow-up's approvals are exactly the item's ids: a skip recorded after the item is not approved`
    - `a crash after the answer: the follow-up starts at the next start-up`
    - `retry on the source is refused while the follow-up is pending, naming it, and run these now is refused while
      the source is retried`
    - `removing the unstarted follow-up lets Retry through`
    - `an approved host is in the follow-up's first run's hosts`
    - `the follow-up's spec carries the approved lines` (open the lane on the fake and read `spec.policy.allow`)
  - `e2e/skipped.spec.ts`: a fake task skips a deploy and ends. The Inbox item shows; press Run these now. A follow-up
    task appears on the Board, with the approved call in its description.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/skip-follow-up.test.ts src/trust/policy.test.ts test/skip-follow-up.test.ts && pnpm exec vitest run --project db packages/db/src/store/skip-follow-ups.test.ts`
- [ ] **Step 3: Generate the migration** (`--name skip_follow_ups`), then implement.
- [ ] **Step 4: Run them, then `src/delivery`, `src/runner`, the e2e
  (`pnpm exec playwright test e2e/skipped.spec.ts`), typecheck, lint and knip.**
- [ ] **Step 5: Run it before review** with `/browse`, as in Task 9, through Run these now to the follow-up's start.
- [ ] **Step 6: Commit** as `feat(daemon): run these now starts a follow-up with the listed calls approved`, with these
  value cards:
  - `protects=the follow-up starts from where the source stands when it starts, never shares a branch with a second
    pull request, survives a crash, and approves exactly what the builder saw; fails_when=two batches own one branch,
    a follow-up cuts from a branch already merged, or an unseen skip is approved; why_new=no follow-up ran approved
    calls; no_claim=the judge honours the approval (Task 0 (a))`
  - `protects=a classifier skip comes back as one quoted allow line; fails_when=an exact skip becomes a line, or a
    summary breaks its line; why_new=TrustPolicy.allow was empty; no_claim=the classifier's reading of it`
  - `protects=the click-through from a skip to a started follow-up; fails_when=the item, the button or the Board breaks
    end to end; why_new=no e2e covered skips; no_claim=the follow-up's own work`

---

### Task 11: A new network host goes to the judge

This changes which hosts a run reaches. Small steps, three commits, the broker over a real store.

**Files:**

- Modify: `packages/contracts/src/judge.ts` (`JudgeDecision.NetworkHost`), `ids.ts` (`RunHost`, prefix `rhs`),
  `skipped-actions.ts` (`RunHostDto`) and `generated/*`.
- Modify: `packages/db/src/schema.ts`. Create `packages/db/drizzle/<next>_run_hosts.sql` (generated), and
  `packages/db/src/store/run-hosts.ts` with `run-hosts.test.ts`.
- Create: `apps/daemon/src/trust/host-judge.ts` and `host-judge.test.ts`.
- Modify: `apps/daemon/src/inbox/permission-broker.ts`: `judgeHost`, when unattended.
- Modify: `apps/daemon/src/runner/runner.ts`. The broker gets `hostJudge: Judge` (the `judge/` service; distinct from
  Task 4's `liveJudge`), `policy`, and `recentCommand(): string | null`: the latest Bash or Monitor command the guard
  let run in this session.
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts`. `forSession`'s allowed hosts add the run's `allowed`
  `run_hosts`, for every session of the run.
- Modify: `apps/desktop/src/views/settings/*` only if decisions are listed by key there, adding one label: `New network hosts`.

**Interfaces:**

- **`run_hosts`** is append-only: `id` (`rhs_`), `workstream_id`, `host`, `verdict` (`allowed` | `refused`), `command`
  (nullable, cut at 500), `reason` (nullable), `judge_call_id` (nullable) and `created_at`. It is unique on
  `(workstream_id, host)`, and written with `ON CONFLICT DO NOTHING`.
- **`HostRequest`** is `{ host, recentCommand: string | null, agentReason: string | null, foundIn: string | null, policy, taskTitle, workstreamId, taskId, signal }`.
- **`judgeNewHost({ judge }, req)`** answers
  `{ allowed: true; callId } | { allowed: false; reason: string; limit: LimitName | null; callId: string | null }`:
  - It asks `judge.choose({ decision: 'network_host', state, question, options: ['allow', 'limit'] })`.
  - `state` holds, as lines:
    - the policy's limits, environment and live systems;
    - `Task: ${taskTitle}` and `Host: ${host}`;
    - `The most recent command this session ran, which may not be the one that wants the host: ${JSON.stringify(recentCommand ?? 'none')}`;
    - when given, `Reason given by the agent, which the agent wrote: ${JSON.stringify(agentReason)}`;
    - when given, `The project's ${foundIn} names this host.` (from `foundHostFile`).
  - `question` is this exact copy:
    `Allowing this host lets every later command in this task reach it, not only this one. Answer allow if reaching it crosses none of the limits, or limit if it could send code, files, keys or the conversation out, or write to a live system.`
  - The outcomes **(call 15)**:
    - `answered` with `allow`, at or above the decision's confidence floor: allowed.
    - `limit`: refused, with `limit: 'sends_data_out'` and reason `The judge refused ${host}.`
    - Below the floor: refused, with reason `The judge wasn't sure about ${host}.`
    - Any `fallback`: refused, with reason
      `No judge could decide ${host} (${fallback reason}). Add an OpenRouter key in Settings › Decisions, or allow the host for the project.`
- **The broker's `judgeHost`, unattended** **(call 16)**:
  - A stored rule allows at once. So does `runHostVerdict(...) === 'allowed'`.
  - A host `refused` in this run is a skip, with no judge call (finding 11).
  - When `countRunHosts` is at `RUN_HOSTS_MAX`, it is a skip with reason
    `This task asked for more than ${RUN_HOSTS_MAX} new hosts.`, and no judge call.
  - Otherwise it asks `judgeNewHost`. It records `run_hosts` only for a verdict the judge gave (allowed, `limit` or
    below the floor). A `fallback` (no key, the judge off, a timeout, an error) is a skip that writes no `run_hosts`
    row and doesn't count toward the cap, so the next try asks again (R5).
  - A refusal is a skip (`kind: 'host'`, `source: 'host_judge'`, summary the host itself, as `callSummary` names a
    network request), and a `deny` with `skipMessage`. No card. The item shows it as `reach ${host}`.
  - Attended: today's code **(call 17)**.
- No other run, task or project reads another run's `run_hosts`.

**Per provider:** every Claude kind meets this through `SandboxNetworkAccess`, and Codex through Task 12. Without an
OpenRouter key every new host is a skip on every kind, and the item and the task say what would clear it.

- [ ] **Step 1: Write the failing store test** (`run-hosts.test.ts`):
  - `a verdict for a run holds for that run only` (Review Focus 5: another workstream in the same project reads null)
  - `a second record of the host is not a second row`
  - `judgedHostsForProject lists allowed and refused hosts no stored rule allows yet`
  - `seeded hosts read as allowed`

  Run it, generate the migration (`pnpm --filter @10db/db exec drizzle-kit generate --name run_hosts`), implement, and
  run it. **Commit** as `feat(db): the judge's host verdicts for a run`, with this value card:
  `protects=a host verdict belongs to one run and is written once; fails_when=a verdict leaks to another run, or a
  repeat throws inside the broker's write; why_new=hosts were only project rules; no_claim=who judges them (Step 2)`.
- [ ] **Step 2: Write the failing judge table** (`host-judge.test.ts`), with the judge's fetch faked at the network
  boundary, as `judge.test.ts` fakes it:
  - `allow above the floor is allowed`
  - `allow below the floor is refused, unsure`
  - `limit is refused with sends_data_out`
  - `no key is refused and says how to clear it`
  - `a timeout is refused`
  - `the state labels the recent command and the agent's reason as theirs, quoted`
  - `the question says the allow covers every later command`
  - `a found file is named`

  Run it, implement, and run it again. **Commit** as
  `feat(daemon): 10db's judge decides a new network host with labelled context`, with this value card:
  `protects=the judge sees whose words it reads and what an allow covers, and every failure is a refusal that says
  how to clear it; fails_when=agent text reaches the judge unlabelled, or a fallback allows; why_new=no decision
  judged hosts; no_claim=the verdicts are right (live row, Task 16)`.
- [ ] **Step 3: Write the failing broker rows** (real store):
  - `an unattended lane's new host the judge allows is allowed and kept for the run`
  - `a later session of the run has it in its sandbox's hosts`
  - `the same host later in the run asks the judge once`
  - `a refused host asked again with new wording is skipped without a second judge call` (laundering)
  - `the twenty-first new host is skipped without a judge call`
  - `a timeout is a skip that writes no verdict and doesn't count toward the cap, and the next try asks again`
  - `a refused host is a skip and no card`
  - `an attended pass's new host still raises today's card`

  Run them, implement, and run `src/inbox`, `src/sandbox` and `src/runner` whole. **Commit** as
  `feat(daemon): an unattended lane's new host goes to the judge, never a card`, with this value card:
  `protects=a lane reaches a host only through a stored rule or the judge's allow for that run, a refusal sticks for
  the run, and a run judges at most twenty hosts; fails_when=a host allowed in one run is reachable from another, a
  refused host is re-asked until it passes, or a refused host still cards; why_new=hosts were carded; no_claim=the
  judge's verdicts are right`.

---

### Task 12: Codex asks for a host with `request_host`

**Files:**

- Modify: `packages/contracts/src/mcp-tools.ts` and `generated/*`:
  - `RequestHost`, with input `{ host: z.string().min(1).max(253), why: z.string().min(1).max(500) }` and output
    `{ allowed: z.boolean(), message: z.string() }`.
- Modify: `apps/daemon/src/mcp/tools.ts`, adding the handler:
  - It checks the host first with `checkConcreteHost` (`network-hosts.ts:123-139`). A pattern, a loopback name or an
    address is refused before any judge, with the check's message (finding 10).
  - Unattended, it runs Task 11's broker logic with `agentReason: why`.
  - Attended, it raises today's non-blocking host card through the broker's attended `judgeHost`, and answers
    `{ allowed: false, message: 'Asked the builder. Retry after they answer, or work without it.' }` (finding 13).
- Modify: `apps/daemon/src/runner/runner.ts`. When a Codex lane's turn ends with a host newly allowed in it, the runner
  checks, before Task 7's resume and before the handoff rule, that no outcome is set, the run isn't parked, and no
  handoff stands (a recorded handoff that `handoffStands` accepts ends the step as today, and the host serves the next
  session anyway). It then sets the outcome `{ kind: 'continue_session', hosts }`. The run loop handles that by starting `runSession` again with
  `resumeProviderSessionId`. The new session's sandbox reads the run's hosts (Task 11), and its first message is
  `${hosts.join(', ')} ${hosts.length === 1 ? 'is' : 'are'} reachable now. Carry on where you left off.` **(call 18)**
- Modify: `apps/daemon/src/briefing/prompts.ts`. Codex unattended gets this exact copy:
  `Your network reaches only the project's hosts. If you need another, call request_host with the host and why; an allowed host is reachable once this turn ends and 10db continues you.`
- Test: `apps/daemon/src/sessions/codex-session.test.ts`, `runner/runner.test.ts` and the MCP tool test.

**Per provider:** only Codex is told about it. A Claude lane may call it too, and an allowed host then works on its
next try through Task 11's check. A refused `request_host` is a skip, like any other. A Codex lane that never calls it
meets a silent kernel block, which is not listed (per-provider table).

- [ ] **Step 1: Write the failing rows.**
  - MCP:
    - `a wildcard is refused before the judge`
    - `a loopback name is refused before the judge`
    - `a numeric address is refused before the judge`
    - `request_host the judge allows is recorded for the run`
    - `a refused one is a skip`
    - `in a pass it raises the host card and says so`
  - Codex session: `a resumed thread carries the run's hosts in permissions.lane`, from scripted app-server frames,
    as `codex-session.test.ts` scripts them.
  - Runner:
    - `a codex lane is continued once after its host was allowed`
    - `no continue after a stop`
    - `no continue when a handoff stands`
- [ ] **Step 2: Run them to see them fail. Implement, and run `src/sessions`, `src/mcp` and `src/runner` whole.**
- [ ] **Step 3: Commit** as `feat(daemon): codex asks for a network host with request_host`, with this value card:
  `protects=a Codex lane can ask for a concrete host, and an allowed one reaches it in a resumed session of the same
  thread; fails_when=a pattern reaches the judge, or the host never reaches Codex's sandbox; why_new=Codex blocked
  unlisted hosts silently; no_claim=that the model asks for a host it needs`.

---

### Task 13: Judged hosts in Settings, to keep for the project

This is a vertical slice. Run it before review.

**Files:**

- Modify: `apps/daemon/src/api/app.ts` and `api/services.ts`:
  - `GET /workstreams/:id/hosts` answers `RunHostDto[]`.
  - `GET /projects/:projectId/network-hosts` gains `judged: { host, verdict }[]`, from `judgedHostsForProject`.
  - Keeping a host is the built `POST`, which calls `allowNetworkHost`.
- Modify: `apps/desktop/src/daemon/queries.ts` and the task detail view. Task 8's section gets a **Hosts** list, each
  host with its verdict and command.
- Modify: the project's network hosts section in Settings, which gets a **Judged in recent tasks** list with **Keep**
  per host, refused ones included (finding 13).
- Test: the network hosts route test file, and the two views' tests.

**Per provider:** the same for every account kind.

- [ ] **Step 1: Write the failing tests:**
  - routes: `lists a run's host verdicts`, `judged hosts not yet kept are listed for the project, refused included`,
    and `keeping one moves it to the project's hosts`
  - task view: `shows each host and its verdict`
  - Settings view: `Keep adds a refused host`
- [ ] **Step 2: Run them to see them fail. Implement, run them, then typecheck, lint and knip.**
- [ ] **Step 3: Run it before review** with `/browse`. Use a fake task whose script makes one host request the faked
  judge allows and one it refuses. See both on the task, then Keep the refused one in Settings. No console errors.
- [ ] **Step 4: Commit** as `feat(desktop): hosts the judge decided, on the task and to keep for the project`, with this
  value card:
  `protects=a refused or allowed host can become a project host in one click; fails_when=a refused host has no path to
  allowed, or Keep writes the wrong project; why_new=only carded hosts could be kept; no_claim=the judge's verdicts`.

---

### Task 14: `.env*` by session, and the switch

This changes the sandbox profile, so it gets real Seatbelt rows, in small steps and two commits.

**Files:**

- Modify: `packages/contracts/src/trust.ts` (`TRUST_SWITCH_KEYS` gains `envFiles`, with `TRUST_DEFAULTS.envFiles = false`)
  and `trust.test.ts`.
- Modify: `apps/daemon/src/permissions/trust-switches.test.ts`, where a stored object without `envFiles` reads false.
- Create: `apps/daemon/src/sandbox/secrets-access.ts` and `secrets-access.test.ts`.
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts:388-394`. The `.env*` `Read(//path)` rules are `disallowedTools`
  when `Closed`. When `Open` with the switch off, they are `ask` rules. When the switch is on, there are none.
- Modify: `apps/daemon/src/sandbox/profile.ts:344-350`. `denyRead` holds `checkoutSecrets` only when `Closed`, and
  `refuseSecretsOverNeeds` still runs then.
- Modify: `apps/daemon/src/sandbox/file-access.ts`, in `judgeRead`'s `secretFiles`:
  - `Closed` → `protected`, with the secret tag (Task 3).
  - `Open` with the switch off → `ask` with `AskKind.SecretRead`, reason
    `${path} is a .env file: reading secrets is a limit, so the builder is asked.`
  - The switch on → an ordinary checkout file.
  - When Task 0 (c) found that Claude Code searches the files, a Grep or Glob whose scope holds a checkout secret is
    `ask` with `SecretRead` under `Open` with the switch off.
- Modify: `apps/daemon/src/guard/pre-tool-use.ts`, where `onlyReads` leaves a word naming a checkout secret to the
  file-access judge.
- Modify the callers of `forSession`:
  - `runner/runner.ts:2033`: `secrets: secretsAccessFor(spec.policy.attended, switches.envFiles, liveJudge.current())`;
  - Plan's sandbox deps (`daemon/shape-session-tools.ts:160`, or M4b's place): `secretsAccessFor(true, switches.envFiles, planJudge)`.
- Test: `apps/daemon/src/sandbox/lane-sandbox.test.ts` (Seatbelt rows), `file-access.test.ts` and
  `guard/unattended.test.ts`.

**Interfaces:**

- **`secretsAccessFor(attended, envFiles, judge)`** **(call 19)**:
  - `envFiles` → `Open`.
  - Attended on `native` → `Open`.
  - Attended on `rules` or `tendb` → `Closed` (finding 12). The refusal then reads:
    `${path} is a .env file. This account has no judge to ask you about secrets yet; turn on Agents may read .env files to read them.`
  - Otherwise → `Closed`.
- The profile is fixed when the session starts. A switch change applies from the next session.

**Per provider:**

- Attended Claude on `native`: open, with a card for a Read. A Bash `cat .env` meets the classifier's
  `Reading Secrets` soft deny (T3), and also a card where the guard reads the word.
- Attended gateway, off-auto Claude and Codex: closed, saying so. That is a parity gap T5 closes.
- Codex gets the kernel rule through `filesystemOf`.

- [ ] **Step 1: Write the failing tests.**
  - `secrets-access.test.ts`: every combination of attended × `envFiles` × judge (12 rows).
  - `lane-sandbox.test.ts`, on real Seatbelt through srt. Each row uses a temp checkout holding `.env`, a `.env.local`
    link and `.ENV.production` (Review Focus 4):
    - `closed: cat .env fails`
    - `closed: cat through the link fails`
    - `closed: the case-folded name fails`
    - `closed: a hard link made in the session can't read it`. If it reads, that is a finding fixed in this task, by
      refusing hard links to a secret path in the profile, and it goes to Task 17.
    - `open: cat .env reads it`
    - `open: the Read rule is an ask rule`
    - `open with the switch: no Read rule`
  - `file-access.test.ts`:
    - `open: Read of .env asks`
    - `open: Grep over the checkout behaves as Task 0 (c) found`
    - `open with the switch: no ask`
    - `closed: refused, with the secret tag`
    - `closed on rules attended: the refusal says this account has no judge yet`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/secrets-access.test.ts src/sandbox/lane-sandbox.test.ts src/sandbox/file-access.test.ts`
- [ ] **Step 3: Implement the sandbox half: `secrets`, the profile and the rules.** Run `src/sandbox` whole, then
  commit as `feat(daemon): a checkout's .env files open to attended sessions with a judge and stay closed to tasks`,
  with this value card:
  `protects=an unattended lane, or an attended one with no judge, can't read .env in the kernel by name, link, case or
  hard link; an attended session with a judge can, after asking; fails_when=Open leaks to a lane or to a rules
  session, or Closed misses a link, a case or a hard link; why_new=every session was Closed; no_claim=that a read
  hidden from the guard is listed`.
- [ ] **Step 4: Implement the guard half and the switch key, and wire both callers.** Run `src/guard`, `src/runner`,
  `src/permissions`, the contracts tests, and `pnpm --filter @10db/contracts generate`. Then commit as
  `feat(daemon): reading a .env file asks in a judged conversation and is a skip in a task`, with this value card:
  `protects=the switch opens .env reads everywhere from the next session, and with it off a task's read is listed and
  a judged conversation's read is a card; fails_when=a switch change reaches a running session, or a task's .env read
  fails unlisted; why_new=the switch didn't exist; no_claim=reads the guard can't see`.

---

### Task 15: "Agents may read `.env` files" in Settings

This is a vertical slice. Run it before review.

**Files:**

- Modify: `apps/desktop/src/views/settings/trust-rows.ts` (the row), `trust-section.tsx`, `project-trust-section.tsx`,
  and their tests.

**Interfaces:**

- The row's label is `Agents may read .env files`. Its description is this exact copy:
  `Off: tasks can't read a project's .env files, and a conversation asks you first where its account has a judge. On: every session reads them without asking. Applies from the next session.`
- It is off by default, and overridable per project, like T2's rows.

**Per provider:** the same switch for every account kind.

- [ ] **Step 1: Write the failing tests:**
  - `the switch shows off by default`
  - `turning it on for a project sends envFiles: true`
- [ ] **Step 2: Run them to see them fail. Implement, run them, then typecheck and lint.**
- [ ] **Step 3: Run it before review** with `/browse`. Turn the switch on for a project, start a task, and check that
  `denyRead` in the daemon log's session line holds no `.env`. No console errors.
- [ ] **Step 4: Commit** as `feat(desktop): a project can let agents read its .env files`, with this value card:
  `protects=the builder can open .env reads per project and sees that it applies next session; fails_when=the switch
  sends to the wrong project or shows on by default; why_new=the setting is new; no_claim=the sandbox (Task 14)`.

---

### Task 16: The threat model, the rules, and the live rows

**Files:**

- Modify: `docs/architecture/03-trust-boundaries.md`:
  - §4.3: unattended work never waits. Cover the unattended table, the broker's skip, the questions and the host
    judge.
  - §6: `.env*` by session and judge, the switch, and hosts kept per run.
  - §7, "Known and accepted":
    - a read hidden from the guard in a closed session fails without a listing (call 19);
    - agent-written config is listed, but not gated beyond what loads it (calls 6 and 22);
    - T2 loads `.claude/skills|agents|commands` from a lane's checkout, so a definition an implementer writes reaches
      its own run's later review step. It is cleaned, but its prose is not judged (finding 27);
    - the host judge reads the agent's words, labelled, and its fallback is a skip (call 15).
- Modify: `apps/daemon/AGENTS.md`:
  - the `trust/` bullet gains the skip recorder, the host judge and `call-summary.ts`;
  - the broker never waits for an unattended lane.
- Modify: the research notes' "Live checks": Task 0's three answers.
- Modify: `apps/daemon/test/lane-sandbox.live.test.ts` (manual, never CI), adding these rows on a Claude plan:
  1. `an unattended lane's classifier denial is listed and the lane finishes`. With a fake `bin/vercel`, the brief
     asks for `bin/vercel deploy --prod`, then `done.txt`. Expect one `skipped_actions` row, `done.txt`, and the
     Inbox item.
  2. `a turn a skip stopped is resumed`. Record whether the model ended its turn after the denial, and whether the
     resume carried it on.
  3. `an unattended lane writes .claude/settings.json` (Task 0 (b), rerun through 10db's lane).
  4. `a new host goes to the judge` (needs an OpenRouter key). The brief curls a host the project doesn't list.
- [ ] **Step 1: Write the docs.** Commit as `docs: unattended work skips and lists instead of waiting`.
- [ ] **Step 2: Write the live rows and run them by hand.**
  Run: `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts -t "unattended|skip stopped|settings.json|new host"`
  Record each result, and any denial text, in the PR body and the research notes.
- [ ] **Step 3: Commit** as `test(daemon): live rows for skips, resumes, config writes and host judging`.

---

### Task 17: Adversarial review of the skips, the hosts and the `.env*` split

- [ ] **Step 1: Dispatch the review.** Use the `code-reviewer` agent (opus), round 1. Give it this plan, Tasks 3 to
  14, the base commit, and the attack list below. It returns findings and doesn't edit.
  1. A wait left in an unattended lane. Look for any branch of the broker, `codex-guard.ts`, `mcp/tools.ts` or the
     runner that still reaches `inbox.ask` or `WAITING_HUMAN`. That includes questions and hazard cards.
  2. A `to_judge` or `allow` outcome that lets through something the kernel doesn't bound: a write outside the
     checkout, a protected read, a Read-family call outside the line, a host the proxy refuses, or git state.
  3. An approval that covers more than the builder saw. Try:
     - a call key that collides;
     - a key that survives a changed input;
     - an approved line, a `request_host` `why`, or a recent command that an agent shapes to approve more, to break a
       rendered list, or to read as an instruction to the classifier or the host judge;
     - a skip that is approved without having been listed.
  4. A host allowed for one run reaching another run, another project, the gate, or a later attended session. A
     refused host laundered with new wording, a new session or a resume.
  5. `.env*`. Look for:
     - an `Open` profile reaching an unattended lane (a follow-up, a resumed session, or a pass's page leaving the
       pass) or a `rules` session;
     - a link, hard link or case-folded name that the `Closed` profile misses;
     - `refuseSecretsOverNeeds` skipped for `Open` where it guarded something else;
     - an attended session that started `Open` on `native` and dropped to `rules` mid-session (T3's live judge). Its
       profile stays `Open` until the session ends: check that the guard still asks on each read, and say whether
       that is enough.
  6. Agent-written config:
     - a lane-written `.claude/settings.json` or hook that runs in any later 10db session (for example an unsandboxed
       session's `settingSources: ['project']`);
     - a `.vscode` or `.idea` path that escapes the skip;
     - a lane-written `.claude/skills|agents|commands` definition steering its own run's review step (finding 27).
  7. A run that ends with skips and raises no item, or two items for one listing. Cover a crash, recovery's `FAILED`,
     a restart between the transition and the subscriber, and a retry.
  8. A follow-up that starts on a branch another batch is shipping, or that cuts from a branch that was merged, or
     that is started twice.
- [ ] **Step 2: Fix each blocking finding as its own red-first commit.** Blocking means critical, data-loss,
  stuck-state, security, a broken rule, or a user-visible spec finding. The rest become follow-up tasks. A second round
  checks only those findings and what the fixes broke. At most two fix rounds.

---

## Follow-up tasks to file

- Parity: attended `.env*` reads on `rules` and `tendb` accounts (Task 14, finding 12), for T5.
- Parity: on the `rules` floor, a claimed hazard command is skipped unattended where `native` runs it (finding 21), for
  T5's judge or the broker.
- A Codex lane that never calls `request_host` meets a silent kernel block, which is not listed.

## Unowned

These came up while writing this plan, and no plan in the trust line or the Sessions roadmap builds them:

- **A hash approval for project hooks** (spec §6's row "Load only after the builder approves their hash"). T2 builds
  none. Today hooks load in no sandboxed session, which is what T4's call 6 relies on.
- **The `builder_review` wait** (`runner.ts:3143-3165`). A project with no gate command puts a finished task in
  `WAITING_HUMAN` for the builder's check. It waits by design, but the spec's anti-goal "A task waiting on the builder"
  may want a ruling.
- **Model refusals** (L2) end a step with no permission event, so they are never listed.
