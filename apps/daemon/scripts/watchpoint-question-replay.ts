import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AccountKind,
  effectiveWatchpoints,
  JudgeDecision,
  ProjectId,
  STARTER_WATCHPOINTS,
  TaskId,
  WorkstreamId,
  WorkstreamState,
  type Watchpoint,
  type WatchpointShadow,
} from '@10db/contracts';
import {
  createTestStore,
  getWorkstreamRow,
  openDatabase,
  patchJudgeConfig,
  readProjectWatchpoints,
  readYourWatchpoints,
} from '@10db/db';
import { z } from 'zod';
import { systemClock } from '../src/clock';
import { diffOfRanges, runCommits } from '../src/delivery';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { createJudge, type Judge, type JudgeCredential } from '../src/judge';
import { silentLogger } from '../src/log';
import {
  askWatchpointQuestions,
  questionDiff,
  watchpointHitsAfter,
  type QuestionCandidates,
  type WatchpointChangeReader,
} from '../src/watchpoints';

/**
 * Replays the watchpoint question over a project's finished runs, before it acts: for each question watchpoint, the
 * files its rules leave open in the run's change and the judge's answer, for a hand label of what you would have
 * flagged.
 *
 *   OPENROUTER_API_KEY=<key> pnpm --filter @10db/daemon exec tsx scripts/watchpoint-question-replay.ts \
 *     --db <copy of the database> --repo <the project's checkout> --out <results file> [--limit N] [--model <id>] \
 *     [--starter design-principles|auth-and-permissions]
 *   ANTHROPIC_API_KEY=<key> ... --model <claude id>
 *   AWS_PROFILE=<profile> AWS_REGION=<region> ... --model <bedrock id>
 *
 * `--db` must be a copy: opening it may write to its journal. The credential is read from the environment and used
 * for these calls only; nothing is stored. Without one no model is called: the script counts the runs and the
 * questions it would ask and says there is no credential. The watchpoints are the project's that have a question,
 * or with `--starter` that library starter alone. Results go to `--out` as JSON lines (each question's files, the
 * hunks it read and its answer) followed by a summary; `--limit` keeps the latest N runs.
 *
 * Sample: each Done run of the project at its last recorded commit, read from its base as the runner reads it (its
 * own commits only). Runs whose commits are no longer in the checkout are skipped.
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
    starter: { type: 'string' },
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
const starterKey = z
  .enum(['design-principles', 'auth-and-permissions'])
  .optional()
  .parse(args.starter);

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
if (credential !== null && credential.kind !== AccountKind.OpenRouter && args.model === undefined)
  throw new Error(`--model names the ${credential.kind} model to ask`);

const db = openDatabase(dbPath);
const sql = db.$client;

const project = sql
  .prepare<[string], { id: string }>('SELECT id FROM projects WHERE repo_path = ?')
  .get(repo);
if (project === undefined) throw new Error(`no project has its checkout at ${repo}`);
const projectId = ProjectId.parse(project.id);

function watchpointsAsked(): Watchpoint[] {
  if (starterKey !== undefined) return STARTER_WATCHPOINTS.filter((w) => w.key === starterKey);
  return effectiveWatchpoints(
    readYourWatchpoints(db),
    readProjectWatchpoints(db, projectId),
  ).filter((w) => w.question !== null);
}
const watchpoints = watchpointsAsked();
if (watchpoints.length === 0) {
  console.log('No watchpoint of this project has a question. Pass --starter to replay a starter.');
  process.exit(0);
}

interface Run {
  readonly workstreamId: string;
  readonly taskId: string;
  readonly title: string;
  readonly base: string;
  readonly head: string;
}

const done = sql
  .prepare<[string, string], { id: string; task_id: string; base_head: string; title: string }>(
    `SELECT w.id, w.task_id, w.base_head, t.title
       FROM workstreams w JOIN tasks t ON t.id = w.task_id
      WHERE t.project_id = ? AND w.state = ? AND w.base_head IS NOT NULL
      ORDER BY w.created_at DESC`,
  )
  .all(projectId, WorkstreamState.Done);
const lastCommit = sql.prepare<[string], { sha: string }>(
  `SELECT json_extract(data, '$.sha') AS sha FROM events
    WHERE type = 'commit.recorded' AND entity_type = 'workstream' AND entity_id = ?
    ORDER BY seq DESC LIMIT 1`,
);

const git = createGit();
const sample: Run[] = [];
for (const w of done) {
  if (limit !== undefined && sample.length >= limit) break;
  const head = lastCommit.get(w.id)?.sha;
  if (head === undefined) continue;
  if (!(await git.hasCommit(repo, head)) || !(await git.hasCommit(repo, w.base_head))) continue;
  sample.push({
    workstreamId: w.id,
    taskId: w.task_id,
    title: w.title,
    base: w.base_head,
    head,
  });
}

writeFileSync(outPath, '');
const emit = (line: string): void => {
  appendFileSync(outPath, `${line}\n`);
};
console.log(
  `Sample: ${String(sample.length)} done runs; watchpoints ${watchpoints.map((w) => w.key).join(', ')}.`,
);

/** The run's own changes from its base to the commit replayed, or null when its ranges can't be read. */
async function readerOf(run: Run): Promise<WatchpointChangeReader | null> {
  try {
    const row = getWorkstreamRow(db, WorkstreamId.parse(run.workstreamId));
    const { ranges } = await runCommits({ db, git }, row, repo, run.base, run.head);
    if (ranges.length === 0) return null;
    return (only, maxBytes) =>
      diffOfRanges(git, repo, ranges, maxBytes, only === null ? undefined : { only });
  } catch {
    return null;
  }
}

/** The questions a run's change raises, and what `ask` answered; null when the change can't be read. */
async function questionsOf(
  run: Run,
  ask: (
    read: WatchpointChangeReader,
    candidates: readonly QuestionCandidates[],
  ) => Promise<readonly WatchpointShadow[]>,
): Promise<{
  read: WatchpointChangeReader;
  asked: readonly QuestionCandidates[];
  shadow: readonly WatchpointShadow[];
} | null> {
  const read = await readerOf(run);
  if (read === null) return null;
  let asked: readonly QuestionCandidates[] = [];
  try {
    const detail = await watchpointHitsAfter({
      watchpoints,
      head: run.head,
      read,
      ask: (candidates) => {
        asked = candidates;
        return ask(read, candidates);
      },
    });
    return { read, asked, shadow: detail.shadow ?? [] };
  } catch {
    return null;
  }
}

if (credential === null) {
  let runs = 0;
  let questions = 0;
  let unreadable = 0;
  for (const run of sample) {
    const found = await questionsOf(run, () => Promise.resolve([]));
    if (found === null) unreadable += 1;
    else {
      runs += 1;
      questions += found.asked.length;
    }
  }
  const summary = `no credential: no model was called. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or AWS_PROFILE and AWS_REGION. Sample: ${String(runs)} runs read, ${String(questions)} questions it would ask, ${String(unreadable)} runs whose changes can't be read.`;
  emit(summary);
  console.log(summary);
  process.exit(0);
}

const { store } = createTestStore();
const state = createStateStore(store, createEventBus());
state.write((ctx) => {
  patchJudgeConfig(ctx, {
    decisions: {
      [JudgeDecision.WatchpointQuestion]: {
        enabled: true,
        ...(args.model === undefined ? {} : { model: args.model }),
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

const answers: (number | null)[] = [];
let unreadable = 0;
for (const run of sample) {
  const ids = {
    workstreamId: WorkstreamId.parse(run.workstreamId),
    taskId: TaskId.parse(run.taskId),
  };
  const found = await questionsOf(run, (read, candidates) =>
    askWatchpointQuestions({ judge, read }, candidates, ids),
  );
  if (found === null) {
    unreadable += 1;
    continue;
  }
  for (const candidate of found.asked) {
    const shadow = found.shadow.find((s) => s.key === candidate.key);
    const yes = shadow?.yes ?? null;
    answers.push(yes);
    const diff = await questionDiff(found.read, candidate.paths).catch(() => null);
    emit(
      JSON.stringify({
        task: run.taskId,
        title: run.title,
        workstream: run.workstreamId,
        head: run.head,
        watchpoint: candidate.key,
        question: candidate.question,
        asked: shadow?.asked ?? [],
        more: shadow?.more ?? candidate.paths.length,
        hunks: diff?.text ?? null,
        truncated: diff?.truncated ?? null,
        yes,
      }),
    );
  }
}

const answered = answers.filter((p): p is number => p !== null);
const lines = [
  '',
  `Watchpoint question replay: ${credential.kind}, ${args.model ?? 'default model'}; ${watchpoints.map((w) => w.key).join(', ')}`,
  `Questions asked                               ${String(answers.length)}`,
  `Answered yes (p >= 0.5)                       ${String(answered.filter((p) => p >= 0.5).length)}`,
  `Answered no                                   ${String(answered.filter((p) => p < 0.5).length)}`,
  `No answer                                     ${String(answers.length - answered.length)}`,
  `Runs skipped (their own commits can't be read) ${String(unreadable)}`,
];
for (const line of lines) emit(line);
console.log(lines.join('\n'));
