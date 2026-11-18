import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixBy, Rigor, Verdict, WorkstreamState, WorkstreamStep } from '@10db/contracts';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isolatedGitEnv, TEST_REPO_CONFIG, tempDir, type TempDir } from '../../test/fixtures';
import { loadEvalProject, PROJECT_FILE, type EvalCase } from './case';
import { GateResult, Outcome } from './grade';
import { EvalAgent, EvalReport } from './report';
import { RUNS_PER_CASE, runEval, writeRun } from './run';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A source repo with a base commit and the commit that "merged" the case, as 10db's history has. */
function decoySource(): { source: string; base: string; merged: string } {
  const dir = tempDir('eval-source');
  dirs.push(dir);
  const source = dir.path;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) git('config', key, value);
  git('config', 'user.email', 'test@10db.invalid');
  git('config', 'user.name', 'test');
  mkdirSync(join(source, 'apps/daemon/src'), { recursive: true });
  writeFileSync(join(source, 'apps/daemon/src/notice.ts'), 'export const notice = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(source, 'apps/daemon/src/notice.ts'), 'export const notice = 2;\n');
  git('commit', '-q', '-am', 'merged');
  return { source, base, merged: git('rev-parse', 'HEAD') };
}

/** Replays the decoy case on the fake agent at `rigor`, in a work dir of its own. */
async function runDecoy(rigor: Rigor, plansInBuild?: boolean, fixBy?: FixBy) {
  const { source, base, merged } = decoySource();
  const workDir = tempDir('eval-work');
  dirs.push(workDir);
  const work = realpathSync(workDir.path);
  const decoy: EvalCase = {
    id: 'decoy-notice',
    title: 'The notice reads two',
    description: 'Change the notice in apps/daemon/src/notice.ts to 2.',
    acceptanceCriteria: ['notice is 2'],
    areas: ['daemon'],
    baseCommit: base,
    mergedCommit: merged,
    tags: [],
  };
  const report = await runEval({
    rigor,
    agent: EvalAgent.Fake,
    cases: [decoy],
    project: loadEvalProject(PROJECT_FILE),
    source,
    work,
    parallel: 1,
    caseTimeoutMs: 60_000,
    builder: {
      dataDir: '/nonexistent/builder/10db',
      worktreeBase: '/nonexistent/builder/worktrees',
    },
    log: () => undefined,
    ...(plansInBuild === undefined ? {} : { plansInBuild }),
    ...(fixBy === undefined ? {} : { fixBy }),
  });
  return { report, work, decoy };
}

/** The steps each workstream the eval daemon ran, read from its own database. */
function stepsRun(work: string): WorkstreamStep[][] {
  const db = new Database(join(work, 'data', '10db.sqlite'), { readonly: true });
  try {
    const rows = z
      .array(z.object({ steps: z.string() }))
      .parse(db.prepare('SELECT steps FROM workstreams').all());
    return rows.map((r) => z.array(WorkstreamStep).parse(JSON.parse(r.steps)));
  } finally {
    db.close();
  }
}

describe('runEval on the fake agent', () => {
  it('runs Careful as Build then Review when it plans in the Build session, and keeps the plan', async () => {
    const { report, work } = await runDecoy(Rigor.Careful, true);
    expect(report.plansInBuild).toBe(true);
    const runs = report.cases[0]?.runs ?? [];
    expect(runs).toHaveLength(RUNS_PER_CASE);
    for (const run of runs)
      expect(run).toMatchObject({
        outcome: Outcome.Met,
        reviewVerdict: Verdict.Approve,
        sessions: 2,
      });
    for (const steps of stepsRun(work)) {
      expect(steps.map((s) => s.role)).toEqual(['implement', 'review']);
      expect(steps[0]).toMatchObject({
        plansFirst: true,
        result: { summary: expect.stringContaining('Fake plan') as unknown, verdict: null },
      });
    }
  }, 180_000);

  it('forces the fix setting on the eval daemon’s playbook and records it in the report', async () => {
    const { report, work } = await runDecoy(Rigor.Careful, undefined, FixBy.Resumed);
    expect(report.fixBy).toBe(FixBy.Resumed);
    expect(report.plansInBuild).toBeNull();
    const db = new Database(join(work, 'data', '10db.sqlite'), { readonly: true });
    try {
      const rows = z
        .array(z.object({ rigor: z.string(), fix_by: z.string().nullable() }))
        .parse(db.prepare('SELECT rigor, fix_by FROM playbook_rows').all());
      expect(rows).toEqual([{ rigor: Rigor.Careful, fix_by: FixBy.Resumed }]);
    } finally {
      db.close();
    }
    for (const run of report.cases[0]?.runs ?? []) expect(run.outcome).toBe(Outcome.Met);
  }, 180_000);

  it('replays a case twice through a daemon of its own and reports, keeping the transcripts dir', async () => {
    const { report, work, decoy } = await runDecoy(Rigor.Standard);

    const runs = report.cases[0]?.runs ?? [];
    expect(runs).toHaveLength(RUNS_PER_CASE);
    for (const run of runs) {
      expect(run).toMatchObject({
        outcome: Outcome.Met,
        workstreamState: WorkstreamState.Done,
        gate: GateResult.Passed,
        reviewVerdict: Verdict.Approve,
        reviewRounds: 1,
        sessions: 2,
        handoffs: 0,
        spawns: null,
        missingTranscripts: [],
      });
      expect(
        run.rules.every((r) => r.held),
        JSON.stringify(run.rules),
      ).toBe(true);
    }
    // The daemon's data stayed in the run's own work dir.
    expect(existsSync(join(work, 'data', '10db.sqlite'))).toBe(true);

    const baseline: EvalReport = {
      ...report,
      cases: [
        {
          id: decoy.id,
          title: decoy.title,
          runs: runs.map((r) => ({ ...r, outcome: Outcome.NotMet })),
        },
      ],
    };
    const { markdown } = writeRun({ work, report, baseline, saveBaselineTo: null });
    expect(markdown).toContain(`- ${decoy.id}: not_met, not_met → met, met`);
    expect(EvalReport.parse(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')))).toEqual(
      report,
    );
    // The case repos go once the report is written; the transcripts the report read stay.
    expect(existsSync(join(work, 'repos'))).toBe(false);
    expect(existsSync(join(work, 'transcripts', `${decoy.id}-1`))).toBe(true);
  }, 180_000);
});
