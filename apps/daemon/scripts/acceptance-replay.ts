import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AcceptanceVerdict,
  AccountKind,
  JudgeDecision,
  TaskId,
  WorkstreamId,
  type AcceptanceCriterionResult,
} from '@10db/contracts';
import {
  createTestStore,
  getJudgeConfig,
  getWorkstreamRow,
  openDatabase,
  patchJudgeConfig,
} from '@10db/db';
import { z } from 'zod';
import { checkAcceptance } from '../src/acceptance';
import { systemClock } from '../src/clock';
import { diffOfRanges, runCommits } from '../src/delivery';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { createJudge, type Judge, type JudgeCredential } from '../src/judge';
import { silentLogger } from '../src/log';

/**
 * Replays the acceptance check over finished runs of one project, for the launch bar: does it agree with the
 * reviewer, how many reviewer-approved runs would it send back, how often is it unclear on runs no review read, and
 * what does it say of the tasks the builder reopened after Done (for a hand label).
 *
 *   OPENROUTER_API_KEY=<key> pnpm --filter @10db/daemon exec tsx scripts/acceptance-replay.ts \
 *     --db <copy of the database> --repo <the project's checkout> --out <results file> [--limit N] [--model <id>] [--second <id>]
 *   ANTHROPIC_API_KEY=<key> ... --model <claude id> --second <claude id>
 *   AWS_PROFILE=<profile> AWS_REGION=<region> ... --model <bedrock id> --second <bedrock id>
 *
 * `--db` must be a copy: opening it may write to its journal. The credential is read from the environment and used
 * for these calls only; nothing is stored. Without one no model is called: the script counts the sample it would
 * read and says there is no credential. Results go to `--out` as JSON lines followed by a summary table; `--limit`
 * keeps the latest N runs of each kind of sample.
 *
 * Sample, each at the head the check would have read: a run with a Review step, at its last commit recorded before
 * the Review began; a run with no Review, at its last commit; a task reopened after Done, at the last commit
 * recorded before it reopened. Only runs whose commits are still in the checkout and whose task has criteria count.
 */
const Env = z.object({
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AWS_PROFILE: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
});
const env = Env.parse(process.env);
const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string' },
    limit: { type: 'string' },
    model: { type: 'string' },
    second: { type: 'string' },
  },
});
const dbPath = z
  .string()
  .min(1)
  .parse(args.db, { error: () => '--db <copy> is required' });
const repo = z
  .string()
  .min(1)
  .parse(args.repo, { error: () => '--repo <checkout> is required' });
const outPath = z
  .string()
  .min(1)
  .parse(args.out, { error: () => '--out <file> is required' });
const limit = z.coerce.number().int().min(1).optional().parse(args.limit);

function credentialOf(): JudgeCredential | null {
  if (env.OPENROUTER_API_KEY !== undefined)
    return { kind: AccountKind.OpenRouter, key: env.OPENROUTER_API_KEY };
  if (env.ANTHROPIC_API_KEY !== undefined)
    return { kind: AccountKind.AnthropicApiKey, key: env.ANTHROPIC_API_KEY };
  if (env.AWS_PROFILE !== undefined && env.AWS_REGION !== undefined)
    return {
      kind: AccountKind.Bedrock,
      region: env.AWS_REGION,
      awsProfile: env.AWS_PROFILE,
      bearerToken: null,
    };
  return null;
}
const credential = credentialOf();
if (credential !== null && credential.kind !== AccountKind.OpenRouter) {
  if (args.model === undefined || args.second === undefined)
    throw new Error(`--model and --second name the ${credential.kind} models to ask`);
}

const Kind = { Reviewed: 'reviewed', Unreviewed: 'unreviewed', Reopened: 'reopened' } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface Case {
  readonly kind: Kind;
  readonly workstreamId: string;
  readonly taskId: string;
  readonly title: string;
  readonly why: string;
  readonly description: string;
  readonly criteria: readonly string[];
  readonly base: string;
  readonly head: string;
  readonly gate: { command: string; summary: string };
  readonly report: string | null;
  /** The reviewer's first verdict, for a reviewed run. */
  readonly reviewer: string | null;
}

const db = openDatabase(dbPath);
const sql = db.$client;

const Steps = z.array(
  z.object({
    role: z.string(),
    startedAt: z.string().nullable(),
    result: z.object({ verdict: z.string().nullish() }).loose().nullable(),
  }),
);
const Criteria = z.array(z.string());

interface WorkstreamRow {
  id: string;
  task_id: string;
  base_head: string | null;
  steps: string;
  title: string;
  why: string;
  description: string;
  acceptance_criteria: string;
}

const workstreams = sql
  .prepare<[string], WorkstreamRow>(
    `SELECT w.id, w.task_id, w.base_head, w.steps, t.title, t.why, t.description, t.acceptance_criteria
       FROM workstreams w JOIN tasks t ON t.id = w.task_id
      WHERE t.project_id = (SELECT id FROM projects WHERE repo_path = ?)
        AND w.base_head IS NOT NULL AND t.acceptance_criteria <> '[]'
      ORDER BY w.created_at DESC`,
  )
  .all(repo);

const lastCommitBefore = sql.prepare<[string, string], { sha: string }>(
  `SELECT json_extract(data, '$.sha') AS sha FROM events
    WHERE type = 'commit.recorded' AND entity_type = 'workstream' AND entity_id = ? AND at < ?
    ORDER BY seq DESC LIMIT 1`,
);
const gateOf = sql.prepare<[string], { command: string | null; summary: string }>(
  `SELECT command, summary FROM evidence WHERE workstream_id = ? AND kind = 'gate' ORDER BY created_at DESC LIMIT 1`,
);
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

const RawReport = z.array(
  z.object({ role: z.string(), report: z.object({ summary: z.string() }).optional() }).loose(),
);

/** The latest report an implement step kept, as the runner hands it to the check. */
function implementReport(steps: string): string | null {
  const parsed = RawReport.safeParse(JSON.parse(steps));
  if (!parsed.success) return null;
  return (
    parsed.data.findLast((s) => s.role === 'implement' && s.report !== undefined)?.report
      ?.summary ?? null
  );
}

function caseFor(kind: Kind, w: WorkstreamRow, head: string, reviewer: string | null): Case | null {
  if (w.base_head === null) return null;
  const gate = gateOf.get(w.id);
  return {
    kind,
    workstreamId: w.id,
    taskId: w.task_id,
    title: w.title,
    why: w.why,
    description: w.description,
    criteria: Criteria.parse(JSON.parse(w.acceptance_criteria)),
    base: w.base_head,
    head,
    gate: { command: gate?.command ?? 'make gate', summary: gate?.summary ?? 'passed' },
    report: implementReport(w.steps),
    reviewer,
  };
}

const candidates: Case[] = [];
for (const w of workstreams) {
  const steps = Steps.parse(JSON.parse(w.steps));
  const review = steps.find((s) => s.role === 'review' && s.startedAt !== null);
  if (steps.some((s) => s.role === 'review')) {
    if (review?.startedAt == null) continue;
    const head = lastCommitBefore.get(w.id, review.startedAt)?.sha;
    const c =
      head === undefined ? null : caseFor(Kind.Reviewed, w, head, review.result?.verdict ?? null);
    if (c !== null) candidates.push(c);
  } else {
    const head = lastCommitBefore.get(w.id, FAR_FUTURE)?.sha;
    const c = head === undefined ? null : caseFor(Kind.Unreviewed, w, head, null);
    if (c !== null) candidates.push(c);
  }
}

// A task reopened after Done: a status change to anything but done after one to done.
const statusEvents = sql
  .prepare<[], { entity_id: string; seq: number; at: string; status: string }>(
    `SELECT entity_id, seq, at, json_extract(data, '$.status') AS status FROM events
      WHERE type = 'task.changed' AND json_extract(data, '$.status') IS NOT NULL ORDER BY seq`,
  )
  .all();
const doneTasks = new Set<string>();
const reopened: { taskId: string; at: string }[] = [];
for (const e of statusEvents) {
  if (e.status === 'done') doneTasks.add(e.entity_id);
  else if (doneTasks.delete(e.entity_id)) reopened.push({ taskId: e.entity_id, at: e.at });
}
for (const r of reopened) {
  const own = workstreams.filter((w) => w.task_id === r.taskId);
  const found = own
    .map((w) => ({ w, head: lastCommitBefore.get(w.id, r.at)?.sha }))
    .find((x) => x.head !== undefined);
  const c = found?.head === undefined ? null : caseFor(Kind.Reopened, found.w, found.head, null);
  if (c !== null) candidates.push(c);
}

const git = createGit();
const sample: Case[] = [];
for (const kind of Object.values(Kind)) {
  let kept = 0;
  for (const c of candidates.filter((x) => x.kind === kind)) {
    if (limit !== undefined && kept >= limit) break;
    if (!(await git.hasCommit(repo, c.head)) || !(await git.hasCommit(repo, c.base))) continue;
    sample.push(c);
    kept += 1;
  }
}

writeFileSync(outPath, '');
const emit = (line: string): void => {
  appendFileSync(outPath, `${line}\n`);
};
const count = (k: Kind): number => sample.filter((c) => c.kind === k).length;
console.log(
  `Sample: ${String(count(Kind.Reviewed))} reviewed, ${String(count(Kind.Unreviewed))} unreviewed, ${String(count(Kind.Reopened))} reopened.`,
);

if (credential === null) {
  const summary = `no credential: no model was called. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or AWS_PROFILE and AWS_REGION. Sample: ${String(count(Kind.Reviewed))} reviewed, ${String(count(Kind.Unreviewed))} unreviewed, ${String(count(Kind.Reopened))} reopened.`;
  emit(summary);
  console.log(summary);
  process.exit(0);
}

const { store } = createTestStore();
const state = createStateStore(store, createEventBus());
state.write((ctx) => {
  patchJudgeConfig(ctx, {
    decisions: {
      [JudgeDecision.Acceptance]: {
        enabled: true,
        ...(args.model === undefined ? {} : { model: args.model }),
      },
      [JudgeDecision.AcceptanceSecond]: {
        enabled: true,
        ...(args.second === undefined ? {} : { model: args.second }),
      },
    },
  });
});
const judge: Judge = createJudge({
  state,
  clock: systemClock,
  fetch,
  readCredential: () => Promise.resolve(credential),
  decisionModelIds: () => null,
  off: false,
  logger: silentLogger,
});
const floors = { first: 0.8, second: 0.7 };
{
  const decisions = getJudgeConfig(state.db).decisions;
  floors.first = decisions[JudgeDecision.Acceptance].floor;
  floors.second = decisions[JudgeDecision.AcceptanceSecond].floor;
}

interface Outcome {
  readonly case: Case;
  readonly results: readonly AcceptanceCriterionResult[] | null;
  readonly unasked: string | null;
}

const outcomes: Outcome[] = [];

/** The run's own changes up to the commit the check would have read, or null when its ranges can't be read. */
async function ownDiff(c: Case): Promise<Awaited<ReturnType<typeof diffOfRanges>> | null> {
  try {
    const row = getWorkstreamRow(db, WorkstreamId.parse(c.workstreamId));
    const { ranges } = await runCommits({ db, git }, row, repo, c.base, c.head);
    if (ranges.length === 0) return null;
    return await diffOfRanges(git, repo, ranges, 240_000);
  } catch {
    return null;
  }
}
let unreadable = 0;
for (const c of sample) {
  // The run's own ranges, as the runner reads them: main's merges and the builder's commits are left out.
  const diff = await ownDiff(c);
  if (diff === null) {
    unreadable += 1;
    continue;
  }
  const read = await checkAcceptance(
    { judge, floors },
    {
      task: { title: c.title, why: c.why, description: c.description },
      criteria: c.criteria,
      accepted: new Set(),
      diff,
      gate: c.gate,
      report: c.report,
      workstreamId: WorkstreamId.parse(c.workstreamId),
      taskId: TaskId.parse(c.taskId),
    },
    AbortSignal.timeout(180_000),
  );
  const outcome: Outcome = {
    case: c,
    results: read?.criteria ?? null,
    unasked: read?.unasked ?? null,
  };
  outcomes.push(outcome);
  emit(
    JSON.stringify({
      kind: c.kind,
      task: c.taskId,
      title: c.title,
      workstream: c.workstreamId,
      head: c.head,
      reviewer: c.reviewer,
      criteria: outcome.results,
      unasked: outcome.unasked,
    }),
  );
}

const has = (o: Outcome, v: AcceptanceVerdict): boolean =>
  o.results?.some((r) => r.verdict === v) ?? false;
const sendsBack = (o: Outcome): boolean => has(o, AcceptanceVerdict.NotMet);
const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}% (${String(n)}/${String(d)})`;

const reviewed = outcomes.filter((o) => o.case.kind === Kind.Reviewed && o.results !== null);
const approved = reviewed.filter((o) => o.case.reviewer === 'approve');
const rejected = reviewed.filter((o) => o.case.reviewer === 'reject');
const unreviewed = outcomes.filter((o) => o.case.kind === Kind.Unreviewed && o.results !== null);
const reopenedOut = outcomes.filter((o) => o.case.kind === Kind.Reopened);
const agree = reviewed.filter((o) => sendsBack(o) === (o.case.reviewer === 'reject')).length;

const lines = [
  '',
  `Acceptance replay: ${credential.kind}, first ${args.model ?? 'default'} (floor ${String(floors.first)}), second ${args.second ?? 'default'} (floor ${String(floors.second)})`,
  `Agreement with the reviewer's first verdict   ${pct(agree, reviewed.length)}`,
  `Reviewer-approved runs it would send back      ${pct(approved.filter(sendsBack).length, approved.length)}`,
  `Reviewer-rejected runs it would send back      ${pct(rejected.filter(sendsBack).length, rejected.length)}`,
  `Unreviewed runs with an unclear criterion      ${pct(unreviewed.filter((o) => has(o, AcceptanceVerdict.Unclear)).length, unreviewed.length)}`,
  `Unreviewed runs it would send back             ${pct(unreviewed.filter(sendsBack).length, unreviewed.length)}`,
  `Runs it could not read (no answer)             ${String(outcomes.filter((o) => o.results === null).length)}`,
  `Runs skipped (their own commits can't be read) ${String(unreadable)}`,
  '',
  'Reopened after Done, for a hand label:',
  ...reopenedOut.map((o) => {
    const verdicts =
      o.results?.map((r) => `${r.verdict}: ${r.criterion}`).join(' | ') ?? 'no answer';
    return `  ${o.case.taskId}  ${o.case.title}\n    ${verdicts}`;
  }),
];
for (const line of lines) emit(line);
console.log(lines.join('\n'));
