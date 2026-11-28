# A change to the agent's guardrails always reaches the builder, held before merge

Size: Core (permissions, git merges, the pull request watch). Four tasks, built in order 1 → 2 → 3 → 4, each after
its predecessor has merged. Stage 8 of `docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md`.
Status: designed, not built. This pull request holds the plan only, and changes no guardrail file.

## Brief

**What changes for the builder.**

- A pull request that touches a guardrail path opens with no auto-merge and raises one card, "A change to your git
  guard is ready" (the label follows the path): the diff, Merge or Close. Nothing merges it until the builder does.
- A write outside every claim onto a guardrail path raises "A lane edited your git guard": the diff, Keep or
  Revert. It was a card with Trust choices and no diff.
- Three questions of the ownership test (one-way door, product and taste, promises in your name) are asked of the
  judge in shadow: logged with their answers, acting on nothing.

**What it buys.** A lane can no longer loosen its own guardrails through an auto-merged pull request. The spec's
table has "A change to a guardrail (no card today)".

**What could go wrong, and how we'd know.**

- A later batch arms auto-merge on a held pull request (a CI fix, a catch-up, a merge retry). The hold is read at
  every caller, over the whole pull request; task 3's test ships a CI-fix batch into a held one.
- A push lands on a pull request that was armed before it was held. Auto-merge is turned off before every push
  while held; a failed turn-off stops the push.
- Too many pull requests held. The Activity panel and the card count show it; the list is one table to trim.
- A stale base ref widens the diff. It errs toward a hold.

**Calls the builder might disagree with.**

1. `AGENTS.md` and `CLAUDE.md`, `.env` files and git's own internals (`.git/config`, `.git/info`) keep today's
   stray card and do not hold a pull request. Spec §1 row 3 does not name them, and agent instructions change in
   most pull requests; the Agent instructions watchpoint already shows them.
2. Judge policy, trust grants and standing approvals live in 10db's database, which no lane or pull request can
   write. Their rows in the list cover the checkout files that grant the same things.
3. The shadow decision ships switched on. It costs a small Decisions spend per ask.
4. Task 4 adds one decision, `ownership_test`, to `packages/contracts/src/judge.ts`. Additive.
5. Known limit: a Workbench pass's pull request (`delivery/pass-pr.ts`) is never merged by 10db, so it already
   waits for the builder, but it gets no guardrail card. A landing into a local copy has no pull request and is not
   held. A follow-up closes both.
6. A pull request whose whole diff can't be read is held.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No migration: state lives in `app_settings`, read
  through zod, with keys only from the exported builders below. Contract changes are additive.
- The hold is decided by the path list alone. No judge answer is an input to `holdAction`, and no code path reads
  one before it (`docs/architecture/decisions/2026-11-27-a-guardrail-change-is-held-by-a-path-list-the-judge-cannot-overrule.md`).
- The hold belongs to the pull request, not to the batch shipping into it: hits and hash cover the whole pull
  request, and the setting is keyed by the root batch.
- `turnOnAutoMerge` and `mergeNow` stay delivery's only callers of `gh.prAutoMerge` and `gh.prMerge`.
- Both cards declare `decidedByBuilder(BuilderOwns.Guardrails)`, have `options` and no `detail.actions`. Labels are
  Title Case; bodies are sentence case.
- No task changes a guardrail file of this repository. Fixtures write theirs in a temp repo.

## Provider parity

The list, the hold and both cards are 10db's own and identical on a Claude plan, Claude through Bedrock or an API
key, and a ChatGPT/Codex plan. The shadow questions need an account decisions run on (OpenRouter, an Anthropic API
key or Bedrock); without one they are not asked, the fallback is logged as today, and nothing depends on the
answers. Spec stage 12 closes that gap.

## Interfaces

```ts
// apps/daemon/src/guardrails/paths.ts (pure)
export const GuardrailKind = {
  GitGuard: 'git_guard',
  CodexRules: 'codex_rules',
  SandboxProfile: 'sandbox_profile',
  JudgePolicy: 'judge_policy',
  TrustGrant: 'trust_grant',
  StandingApproval: 'standing_approval',
  McpServers: 'mcp_servers',
  Hooks: 'hooks',
  CiWorkflows: 'ci_workflows',
} as const;
export interface GuardrailRow {
  readonly kind: GuardrailKind;
  readonly label: string; // "git guard", as in "A change to your git guard is ready"
  matches(rel: string): boolean;
}
export const GUARDRAIL_PATHS: readonly GuardrailRow[]; // first match wins
export function guardrailOf(rel: string): { kind: GuardrailKind; label: string } | null;
export function guardrailHits(paths: readonly string[]): { path: string; kind: GuardrailKind; label: string }[];

// apps/daemon/src/guardrails/ownership.ts (pure)
export const OwnershipQuestion = {
  OneWayDoor: 'one_way_door',
  ProductAndTaste: 'product_and_taste',
  Promise: 'promise',
} as const;
export type OwnershipReading = { readonly yes: boolean; readonly confidence: number } | null; // null: no answer
export function ownershipTest(input: {
  readonly guardrailHits: number;
  readonly judged: Readonly<Partial<Record<OwnershipQuestion, OwnershipReading>>>;
  readonly floor: number;
}): { readonly owns: BuilderOwns[]; readonly doubt: OwnershipQuestion[] };

// apps/daemon/src/delivery/guardrail-hold.ts
export function holdRootOf(batch: Pick<BatchDto, 'id' | 'ciFixOf'>): BatchId; // batch.ciFixOf ?? batch.id
export const guardrailHoldKey = (rootId: BatchId): string => `guardrail_hold.${rootId}`;
export const GuardrailHold = z.object({ approved: z.string().nullable() }); // the diff hash the builder merged
export function pullRequestBase(git: Git, checkout: string, root: BatchDto, head: string): Promise<string | null>;
export function holdAction(input: {
  readonly hits: number | null; // null: the diff could not be read
  readonly diffHash: string | null;
  readonly approved: string | null;
}): 'none' | 'hold' | 'approved';

// apps/daemon/src/github/gh.ts, and its fake
prDisableAutoMerge(input: { repo: string; url: string }, call: GhCall): Promise<void>;
closePullRequest(input: { repo: string; number: number }, call: GhCall): Promise<void>; // only if absent

// apps/daemon/src/inbox/guardrail-card.ts
export const GUARDRAIL_DIFF_DETAIL = 'guardrailDiff';
export const GuardrailPrChoice = { Merge: 'Merge', Close: 'Close' } as const;
export const GuardrailStrayChoice = { Keep: 'Keep', Revert: 'Revert' } as const;

// apps/daemon/src/watcher/kept-copy.ts
/** Writes `<home>/.10db/kept/<projectId>/<UTC stamp>-<sha12>/<rel>` (dirs 0700, file 0600) and returns its path. */
export function keepCopy(home: string, projectId: ProjectId, rel: string, bytes: Uint8Array, now: Date): string;

// packages/contracts/src/judge.ts
JudgeDecision.OwnershipTest = 'ownership_test'; // floor 0.8; question ids are OwnershipQuestion's values
```

## State table (design, not a test list)

`holdAction`, first match wins:

| #   | Case                                    | Result     |
| --- | --------------------------------------- | ---------- |
| 1   | `hits === null` or `diffHash === null`  | `hold`     |
| 2   | `hits === 0`                            | `none`     |
| 3   | `approved !== null && approved === diffHash` | `approved` |
| 4   | otherwise                               | `hold`     |

`hits` and `diffHash` are always over the whole pull request: `pullRequestBase(...)` to the head being pushed, never
the shipping batch's own `baseSha`. `pullRequestBase` is
`git.mergeBase(checkout, head, 'refs/remotes/origin/<root.baseBranch>')`, else `root.baseSha`, else null.

| Pusher                          | Why the merge base is right                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- |
| A root batch's ship             | It is the batch's cut point                                                  |
| A CI-fix batch (`ciFixOf`)      | It is cut from the pull request's head, so its own range hides the root's change |
| A catch-up                      | The base tip was merged in, so the base's own guardrail changes are not counted |

| Moment                                         | What happens                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `none`, or `approved`                          | Today's behavior                                                                               |
| `hold` at ship step 4b (root and `fixPr`)      | No `prAutoMerge`, no `prMerge`; the card is raised on the root's tasks                         |
| `hold` in `retryMerge` and `landing.retryMerge` | Refused                                                                                       |
| `hold` with a push to come (ship, catch-up)    | `prDisableAutoMerge` first, every time, whatever `autoMergeArmed` says; a failure stops the push |
| `batch.autoMerge` false and hits               | The card is still raised; Merge merges                                                         |
| Merge                                          | `approved = diffHash` in the answer's write, then `turnOnAutoMerge` for the root              |
| Close                                          | `closePullRequest`; the root's fix batches end as a closed pull request ends them today        |
| A later push with a different hash             | `hold` again; the card is raised afresh with the new diff                                      |
| The pull request merged or closed              | The card is withdrawn and the setting cleared                                                  |

| Stray write outside every claim                | Card                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `guardrailOf(rel) !== null`, one stamped file  | "A lane edited your `<label>`": a capped diff, Keep or Revert                           |
| Call 1's paths, a bulk batch, an unstamped one | Today's card                                                                            |
| Keep                                           | `applyTrustChoice`, as Keep It does today                                               |
| Revert, tracked                                | Restored from `HEAD`                                                                    |
| Revert, untracked                              | `keepCopy`, read back and compared, then removed; the answer names the kept path        |

Shadow: the three questions are one `judge.assess` call off the write path. Its row is logged with
`JudgeOutcome.Shadow`, an `ownership.shadow` event carries the answers, and nothing reads them.

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: the rule tables. `guardrails/paths.ts`, `guardrails/ownership.ts`; `watcher/strays.ts` delegates.
2. `task-2.md`: the stray card with its diff, Keep and Revert; `keepCopy`.
3. `task-3.md`: the held pull request, its card, Merge and Close; `prDisableAutoMerge`.
4. `task-4.md`: the three ownership questions in shadow.

Criteria: 1 and 5 by task 3 (and task 1's pure test); 2 by task 2; 3 by task 1; 4 by task 4.

Follow-ups filed with this plan: the guardrail card for a pass's pull request and a hold for a local-copy landing;
guardrail paths a project adds for itself; letting the shadow answers act (spec stage 11, after a week of calls).
