import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rigor, Verdict, WorkstreamState } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('runEval on the fake agent', () => {
  it('replays a case twice through a daemon of its own and reports, keeping the transcripts dir', async () => {
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
      rigor: Rigor.Standard,
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
    });

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
