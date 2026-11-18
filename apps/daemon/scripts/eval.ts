/**
 * Replays the lane-pipeline eval set at one rigor and writes its report. `make eval` runs it; see
 * scripts/eval/AGENTS.md. A real run starts real sessions on the default Claude account and spends
 * usage; `--agent=fake` proves the plumbing without either.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rigor } from '@10db/contracts';
import { z } from 'zod';
import { DEFAULT_WORKTREE_BASE } from '../src/daemon';
import { defaultDataDir } from '../src/runtime-files';
import { BASELINES_DIR, CASES_DIR, loadCases, loadEvalProject, PROJECT_FILE } from './eval/case';
import { EvalAgent, EvalReport } from './eval/report';
import { runEval, writeRun } from './eval/run';

const Args = z.strictObject({
  rigor: z.enum(Rigor),
  agent: z.enum(EvalAgent).default(EvalAgent.Claude),
  /** Comma-separated case ids; absent runs them all. */
  cases: z.string().min(1).optional(),
  /** Writes the report as the rigor's baseline as well as into the work dir. */
  saveBaseline: z.enum(['0', '1']).default('0'),
  /** The report to compare with; absent takes the rigor's saved baseline, if there is one. */
  baseline: z.string().min(1).optional(),
  parallel: z.coerce.number().int().min(1).max(8).default(2),
  caseTimeoutMinutes: z.coerce.number().int().min(1).max(600).default(90),
});

// `--case-timeout-minutes=60` becomes { caseTimeoutMinutes: '60' }; Args validates every value.
const argv: unknown = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.replace(/^--/, '').split('='))
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k?.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), v]),
);
const args = Args.parse(argv);

const root = resolve(import.meta.dirname, '../../..');
const wanted = args.cases?.split(',').map((id) => id.trim());
const all = loadCases(CASES_DIR);
const cases = wanted === undefined ? all : all.filter((c) => wanted.includes(c.id));
const unknown = (wanted ?? []).filter((id) => !all.some((c) => c.id === id));
if (unknown.length > 0) throw new Error(`No such case: ${unknown.join(', ')}`);

const baselinePath = args.baseline ?? join(BASELINES_DIR, `${args.rigor}.json`);
const baseline = existsSync(baselinePath)
  ? EvalReport.parse(JSON.parse(readFileSync(baselinePath, 'utf8')))
  : null;
const work = realpathSync(mkdtempSync(join(tmpdir(), '10db-eval-')));
const say = (line: string): void => {
  console.log(`[eval] ${line}`);
};
say(`work dir: ${work}`);
if (args.agent === EvalAgent.Claude)
  say(
    'Lanes run on the default Claude account. Other accounts (Bedrock, an API key, a ChatGPT plan) are not run yet.',
  );

const report = await runEval({
  rigor: args.rigor,
  agent: args.agent,
  cases,
  project: loadEvalProject(PROJECT_FILE),
  source: root,
  work,
  parallel: args.parallel,
  caseTimeoutMs: args.caseTimeoutMinutes * 60_000,
  builder: { dataDir: defaultDataDir(), worktreeBase: DEFAULT_WORKTREE_BASE },
  log: say,
});
const { markdown } = writeRun({
  work,
  report,
  baseline,
  saveBaselineTo: args.saveBaseline === '1' ? join(BASELINES_DIR, `${args.rigor}.json`) : null,
});
console.log(markdown);
say(`report: ${join(work, 'report.md')}`);
const missing = report.cases.flatMap((c) => c.runs.flatMap((r) => r.missingTranscripts));
if (missing.length > 0) say(`${String(missing.length)} session(s) left no transcript on disk`);
process.exitCode = missing.length > 0 ? 1 : 0;
