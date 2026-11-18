import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ClaimKind,
  DEFAULT_HAZARDS,
  FixBy,
  InboxKind,
  InboxState,
  PlanChoice,
  PlaybookDto,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
  WorkstreamState,
  WorkstreamStep,
  type PlaybookInput,
  type Rigor,
} from '@10db/contracts';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { LaneBrief } from '../../src/briefing';
import { loginConfigDirOf } from '../../src/environment';
import { OP_TRAILER, withoutGitRepoEnv } from '../../src/git';
import { classifyPath } from '../../src/guard';
import { runningDaemon } from '../../src/runtime-files';
import { DAEMON_STOP_TIMEOUT_MS, stopChild } from '../live-processes';
import type { EvalCase, EvalProject } from './case';
import { evalDaemonEnv, type BuilderPlaces } from './daemon-env';
import { fakeBookFor, type FakeCase } from './fake-book';
import { checkLaneRules, dependencyFieldsDiffer, gateResultOf, outcomeOf, reviewOf } from './grade';
import { EvalAgent, renderReport, type CaseReport, type CaseRun, type EvalReport } from './report';
import { keepTranscripts } from './transcripts';

/** Each case runs this many times, so a flip between runs shows how steady its outcome is. */
export const RUNS_PER_CASE = 2;

/** The gate a case-run's project runs: 10db's own changed-package check, or for the fake a clean tree. */
const GATE = {
  [EvalAgent.Claude]: 'make check-changed',
  [EvalAgent.Fake]: 'git diff --quiet HEAD',
} as const;

const POLL_MS = 1_000;
const DAEMON_START_MS = 60_000;

export interface EvalOptions {
  readonly rigor: Rigor;
  readonly agent: EvalAgent;
  readonly cases: readonly EvalCase[];
  readonly project: EvalProject;
  /** A checkout of 10db with the cases' commits in its history; it is only read. */
  readonly source: string;
  /** The run's own directory: its daemon's data, the case repos, the transcripts and the report. */
  readonly work: string;
  readonly parallel: number;
  readonly caseTimeoutMs: number;
  readonly builder: BuilderPlaces;
  readonly log: (line: string) => void;
  /**
   * Sets the rigor's plansInBuild on the eval daemon's global playbook, to compare planning in the Build
   * session with a separate Plan step. Absent runs the playbook as 10db ships it.
   */
  readonly plansInBuild?: boolean;
  /**
   * Sets the rigor's fixBy on the eval daemon's global playbook, to compare a fix that resumes the Build
   * session with a fresh one. Absent runs the playbook as 10db ships it.
   */
  readonly fixBy?: FixBy;
  /**
   * Sets how the eval daemon briefs its lanes (`TENDB_LANE_BRIEF`), to compare a brief that pastes the
   * Plan and knowledge with one that indexes them. Absent runs the daemon's default.
   */
  readonly brief?: LaneBrief;
}

export class EvalRunError extends Error {
  override readonly name = 'EvalRunError';
}

const DAEMON_DIR = resolve(import.meta.dirname, '../..');
const CATALOGUE_SNAPSHOT = join(DAEMON_DIR, 'test/fixtures/catalogue.json');

/** Git outside any repository an inherited GIT_DIR names. */
function git(cwd: string, args: readonly string[], input?: Buffer): string {
  return execFileSync('git', args, {
    cwd,
    env: withoutGitRepoEnv(process.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The case's reference diff names a file in its areas; the fake build writes a new file beside it. */
function fakeEditPath(c: EvalCase, opts: EvalOptions): string {
  const changed = git(opts.source, ['diff', '--name-only', c.baseCommit, c.mergedCommit])
    .split('\n')
    .filter((p) => p !== '');
  const inArea = changed.find((p) =>
    classifyPath(p, opts.project.areas, []).areas.some((a) => c.areas.includes(a)),
  );
  const dir = inArea === undefined ? '' : dirname(inArea);
  return join(dir === '.' ? '' : dir, `EVAL-FAKE-${c.id}.md`);
}

/**
 * The case's base as a fresh repo with no later history, so a lane can't read the merged answer, and
 * a bare origin holding main, which `make check-changed` diffs against and which shows any push.
 */
function prepareRepo(
  c: EvalCase,
  slot: string,
  opts: EvalOptions,
): { repo: string; origin: string } {
  const repo = join(opts.work, 'repos', slot);
  const origin = join(opts.work, 'origins', `${slot}.git`);
  mkdirSync(repo, { recursive: true });
  const archive = execFileSync('git', ['-C', opts.source, 'archive', c.baseCommit], {
    env: withoutGitRepoEnv(process.env),
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', repo], { input: archive });
  git(opts.work, ['init', '-q', '--bare', origin]);
  git(opts.work, ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['receive.autogc', 'false'],
    ['user.email', 'eval@10db.invalid'],
    ['user.name', '10db eval'],
    // The base commit is the runner's own, never the builder's signed work.
    ['commit.gpgsign', 'false'],
  ] as const) {
    git(repo, ['config', key, value]);
    git(origin, ['config', key, value]);
  }
  git(repo, ['add', '-A', '-f', '.']);
  git(repo, ['commit', '-q', '-m', `Base of ${c.id} (${c.baseCommit})`]);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'main']);
  if (opts.agent === EvalAgent.Claude)
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: repo,
      stdio: 'ignore',
    });
  return { repo, origin };
}

interface Daemon {
  readonly child: ChildProcess;
  readonly url: string;
  readonly token: string;
  readonly db: Database.Database;
}

async function startDaemon(opts: EvalOptions, fakeBook: string | null): Promise<Daemon> {
  const env = evalDaemonEnv({
    work: opts.work,
    inherited: process.env,
    fakeBook,
    catalogueSnapshot: CATALOGUE_SNAPSHOT,
    builder: opts.builder,
    ...(opts.brief === undefined ? {} : { brief: opts.brief }),
  });
  const dataDir = env['TENDB_DATA_DIR'] ?? join(opts.work, 'data');
  mkdirSync(dataDir, { recursive: true });
  const logFd = openSync(join(opts.work, 'daemon.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DAEMON_DIR,
    env,
    stdio: ['pipe', logFd, logFd],
  });
  closeSync(logFd);
  const deadline = Date.now() + DAEMON_START_MS;
  while (Date.now() < deadline) {
    const running = runningDaemon(dataDir);
    if (running !== null) {
      const url = `http://127.0.0.1:${String(running.info.port)}`;
      const health = await fetch(`${url}/health`).catch(() => null);
      if (health?.ok === true) {
        const db = new Database(join(dataDir, '10db.sqlite'), {
          readonly: true,
          fileMustExist: true,
        });
        return { child, url, token: running.token, db };
      }
    }
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  await stopChild(child, DAEMON_STOP_TIMEOUT_MS);
  throw new EvalRunError(`The eval daemon did not start; see ${join(opts.work, 'daemon.log')}`);
}

async function api<T>(
  d: Daemon,
  schema: z.ZodType<T>,
  path: string,
  body?: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const res = await fetch(`${d.url}${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new EvalRunError(`${path} → ${String(res.status)} ${await res.text()}`);
  return schema.parse(await res.json());
}

const WorkstreamRow = z.object({
  state: z.string(),
  failure_kind: z.string().nullable(),
  failure_reason: z.string().nullable(),
  steps: z.string(),
});
const SessionRow = z.object({
  id: z.string(),
  provider: z.string(),
  provider_session_id: z.string().nullable(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cached_tokens: z.int(),
  cost_usd: z.number().nullable(),
  config_dir: z.string().nullable(),
});
const Name = z.object({ name: z.string() });
const ClaimRow = z.object({ kind: z.string(), name: z.string() });

const ENDED: ReadonlySet<string> = new Set([
  WorkstreamState.Done,
  WorkstreamState.Failed,
  WorkstreamState.Cancelled,
]);

/** Answers the workstream's plan card, if its rigor asks the builder to approve the plan. */
async function approvePlans(d: Daemon, workstreamId: string): Promise<void> {
  const cards = z
    .array(z.object({ id: z.string() }))
    .parse(
      d.db
        .prepare(
          `SELECT id FROM inbox_items WHERE kind = ? AND state = ? AND json_extract(detail, '$.workstreamId') = ?`,
        )
        .all(InboxKind.Plan, InboxState.Open, workstreamId),
    );
  for (const card of cards)
    await api(d, z.unknown(), `/inbox/${card.id}/answer`, { choice: PlanChoice.Approve });
}

/** The commits above the base, each with its op trailer's value or null. */
function commitsOf(repo: string): { sha: string; opTrailer: string | null }[] {
  const log = git(repo, [
    'log',
    `--format=%H%x00%(trailers:key=${OP_TRAILER},valueonly,separator=%x2C)%x01`,
    'HEAD',
    '--not',
    'origin/main',
  ]);
  return log
    .split('\x01')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [sha = '', trailer = ''] = entry.split('\x00');
      return { sha, opTrailer: trailer.trim() === '' ? null : trailer.trim() };
    });
}

/** Paths changed from the base, committed or not, and those whose change alters what is installed. */
function changesOf(repo: string): { changed: string[]; dependency: string[] } {
  const lines = (text: string) => text.split('\n').filter((p) => p !== '');
  const changed = [
    ...new Set([
      ...lines(git(repo, ['diff', '--name-only', 'origin/main'])),
      ...lines(git(repo, ['ls-files', '--others', '--exclude-standard'])),
    ]),
  ].sort();
  const show = (ref: string, path: string): string => {
    try {
      return git(repo, ['show', `${ref}:${path}`]);
    } catch {
      return '{}';
    }
  };
  const dependency = changed.filter((p) => {
    const name = p.split('/').at(-1);
    if (name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml') return true;
    return (
      name === 'package.json' && dependencyFieldsDiffer(show('origin/main', p), show('HEAD', p))
    );
  });
  return { changed, dependency };
}

const DEFAULT_CLAUDE_DIR = (): string =>
  loginConfigDirOf(
    Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  ) ?? join(homedir(), '.claude');

async function runCase(d: Daemon, c: EvalCase, run: number, opts: EvalOptions): Promise<CaseRun> {
  const slot = `${c.id}-${String(run)}`;
  const { repo, origin } = prepareRepo(c, slot, opts);
  const originRefsBefore = git(origin, ['for-each-ref']);
  const project = await api(d, ProjectDto, '/projects', {
    name: `eval-${slot}`,
    repoPath: repo,
    gateCommand: GATE[opts.agent],
    areas: opts.project.areas,
    maxLanes: 1,
    defaultRigor: opts.rigor,
  });
  const task = await api(d, TaskDto, `/projects/${project.id}/tasks`, {
    title: c.title,
    description: c.description,
    acceptanceCriteria: c.acceptanceCriteria,
    areas: c.areas,
    rigor: opts.rigor,
  });
  const started = Date.now();
  const workstream = await api(d, WorkstreamDto, `/tasks/${task.id}/start`, {});
  opts.log(`${slot}: started`);
  const read = () =>
    WorkstreamRow.parse(
      d.db
        .prepare('SELECT state, failure_kind, failure_reason, steps FROM workstreams WHERE id = ?')
        .get(workstream.id),
    );
  let row = read();
  let timedOut = false;
  while (!ENDED.has(row.state)) {
    if (Date.now() - started > opts.caseTimeoutMs) {
      timedOut = true;
      break;
    }
    await approvePlans(d, workstream.id);
    await sleep(POLL_MS);
    row = read();
  }
  const wallSeconds = (Date.now() - started) / 1000;
  opts.log(
    `${slot}: ${timedOut ? 'timed out' : row.state} after ${String(Math.round(wallSeconds))} s`,
  );

  const sessions = z.array(SessionRow).parse(
    d.db
      .prepare(
        `SELECT s.id, s.provider, s.provider_session_id, s.input_tokens, s.output_tokens,
                  s.cached_tokens, s.cost_usd, a.config_dir
             FROM sessions s JOIN accounts a ON a.id = s.account_id
            WHERE s.workstream_id = ? ORDER BY s.sequence`,
      )
      .all(workstream.id),
  );
  const handoffs = z
    .object({ n: z.int() })
    .parse(
      d.db.prepare('SELECT count(*) AS n FROM handoffs WHERE workstream_id = ?').get(workstream.id),
    ).n;
  const claims = z
    .array(ClaimRow)
    .parse(
      d.db.prepare('SELECT kind, name FROM claims WHERE workstream_id = ?').all(workstream.id),
    );
  const toolOps = z
    .array(Name)
    .parse(
      d.db.prepare('SELECT tool AS name FROM tool_ops WHERE workstream_id = ?').all(workstream.id),
    )
    .map((o) => o.name);
  const steps = z.array(WorkstreamStep).parse(JSON.parse(row.steps));

  // The fake agent writes no transcript, so only a real run looks for one.
  const transcripts = keepTranscripts(
    (opts.agent === EvalAgent.Claude ? sessions : []).map((s) => ({
      sessionId: s.id,
      provider: s.provider,
      providerSessionId: s.provider_session_id,
      configDir: s.config_dir ?? DEFAULT_CLAUDE_DIR(),
    })),
    join(opts.work, 'transcripts', slot),
  );
  const { changed, dependency } = changesOf(repo);
  const rules = checkLaneRules({
    changedPaths: changed,
    areas: opts.project.areas,
    hazards: DEFAULT_HAZARDS,
    claimedAreas: [
      ...c.areas,
      ...claims.filter((cl) => cl.kind === ClaimKind.Area).map((cl) => cl.name),
    ],
    claimedHazards: claims.filter((cl) => cl.kind === ClaimKind.Hazard).map((cl) => cl.name),
    commits: commitsOf(repo),
    originRefsBefore,
    originRefsAfter: git(origin, ['for-each-ref']),
    dependencyPathsChanged: dependency,
    toolOps,
  });
  const review = reviewOf(steps);
  const total = (pick: (s: z.infer<typeof SessionRow>) => number) =>
    sessions.reduce((n, s) => n + pick(s), 0);
  const costs = sessions.map((s) => s.cost_usd);
  return {
    run,
    outcome: outcomeOf({ state: row.state, review, rules, timedOut }),
    workstreamState: row.state,
    failureReason: row.failure_reason,
    gate: gateResultOf(row.state, row.failure_kind),
    reviewVerdict: review.verdict,
    reviewRounds: review.rounds,
    sessions: sessions.length,
    handoffs,
    spawns:
      transcripts.kept.length === 0 ? null : transcripts.kept.reduce((n, t) => n + t.spawns, 0),
    inputTokens: total((s) => s.input_tokens),
    outputTokens: total((s) => s.output_tokens),
    cachedTokens: total((s) => s.cached_tokens),
    costUsd: costs.some((x) => x === null) ? null : costs.reduce<number>((n, x) => n + (x ?? 0), 0),
    wallSeconds,
    rules,
    missingTranscripts: [...transcripts.missing],
  };
}

/** Runs `jobs` with at most `limit` at once, keeping their order in the result. */
async function pool<T>(limit: number, jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      const job = jobs[i];
      if (job) results[i] = await job();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

/**
 * Replays every case `RUNS_PER_CASE` times through a daemon of the run's own, each run in a fresh
 * repo, and returns the graded report. The case repos and origins are removed once it is built;
 * the daemon's data and the kept transcripts stay in the work dir.
 */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  mkdirSync(opts.work, { recursive: true });
  for (const c of opts.cases)
    for (const sha of [c.baseCommit, c.mergedCommit]) {
      try {
        git(opts.source, ['cat-file', '-e', `${sha}^{commit}`]);
      } catch {
        throw new EvalRunError(`${c.id}: ${sha} is not a commit in ${opts.source}`);
      }
    }
  let fakeBook: string | null = null;
  if (opts.agent === EvalAgent.Fake) {
    const fakes: FakeCase[] = opts.cases.map((c) => ({
      id: c.id,
      title: c.title,
      editPath: fakeEditPath(c, opts),
    }));
    fakeBook = join(opts.work, 'fake-book.json');
    writeFileSync(
      fakeBook,
      JSON.stringify(fakeBookFor(fakes, opts.rigor, opts.plansInBuild ?? null), null, 2),
    );
  }
  const startedAt = new Date().toISOString();
  const daemon = await startDaemon(opts, fakeBook);
  let runs: CaseRun[][];
  try {
    if (opts.plansInBuild !== undefined || opts.fixBy !== undefined) {
      const input: PlaybookInput = {
        rows: [
          {
            rigor: opts.rigor,
            ...(opts.plansInBuild === undefined ? {} : { plansInBuild: opts.plansInBuild }),
            ...(opts.fixBy === undefined ? {} : { fixBy: opts.fixBy }),
          },
        ],
      };
      await api(daemon, PlaybookDto, '/playbook', input, 'PUT');
      if (opts.plansInBuild !== undefined)
        opts.log(
          `${opts.rigor} plans ${opts.plansInBuild ? 'in the Build session' : 'in a Plan step'}`,
        );
      if (opts.fixBy !== undefined)
        opts.log(
          `${opts.rigor} fixes ${opts.fixBy === FixBy.Resumed ? 'in the Build session' : 'in a fresh session'}`,
        );
    }
    const jobs = opts.cases.flatMap((c) =>
      Array.from({ length: RUNS_PER_CASE }, (_, i) => () => runCase(daemon, c, i + 1, opts)),
    );
    const flat = await pool(opts.parallel, jobs);
    runs = opts.cases.map((_, ci) => flat.slice(ci * RUNS_PER_CASE, (ci + 1) * RUNS_PER_CASE));
  } finally {
    daemon.db.close();
    daemon.child.stdin?.end();
    await stopChild(daemon.child, DAEMON_STOP_TIMEOUT_MS);
  }
  const cases: CaseReport[] = opts.cases.map((c, i) => ({
    id: c.id,
    title: c.title,
    runs: runs[i] ?? [],
  }));
  return {
    rigor: opts.rigor,
    agent: opts.agent,
    plansInBuild: opts.plansInBuild ?? null,
    fixBy: opts.fixBy ?? null,
    brief: opts.brief ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    cases,
  };
}

/**
 * Writes the report as `report.json` and `report.md` in the work dir, and as the rigor's baseline
 * when asked. Only then removes what the run made to replay its cases, the repos and their origins;
 * the daemon's data and the kept transcripts stay.
 */
export function writeRun(input: {
  readonly work: string;
  readonly report: EvalReport;
  readonly baseline: EvalReport | null;
  readonly saveBaselineTo: string | null;
}): { readonly markdown: string } {
  const json = `${JSON.stringify(input.report, null, 2)}\n`;
  const markdown = renderReport(input.report, input.baseline);
  writeFileSync(join(input.work, 'report.json'), json);
  writeFileSync(join(input.work, 'report.md'), markdown);
  if (input.saveBaselineTo !== null) {
    mkdirSync(dirname(input.saveBaselineTo), { recursive: true });
    writeFileSync(input.saveBaselineTo, json);
  }
  rmSync(join(input.work, 'repos'), { recursive: true, force: true });
  rmSync(join(input.work, 'origins'), { recursive: true, force: true });
  return { markdown };
}
