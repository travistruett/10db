import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore } from '../events';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { createEvalsService } from './service';

let repo: TempDir | null = null;
let closeStore: (() => void) | null = null;
afterEach(() => {
  closeStore?.();
  repo?.cleanup();
});

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
};

const gateReport = (passed: boolean, recall: number) =>
  JSON.stringify({
    task: 'chat.answer',
    version: 1,
    fingerprint: 'f',
    repeat: 1,
    passed,
    slots: [
      {
        slot: 'FAST',
        slug: 'vendor/m',
        passed,
        trials: 1,
        gates: { recall: { rate: recall, minimum: 0.8, passed, good: 1, total: 1 } },
        cost: { total: '0.5', basis: 'billed' },
        latency_ms: { p50: 1, p95: 2 },
      },
    ],
  });

const baseline = JSON.stringify({
  rigor: 'standard',
  agent: 'fake',
  startedAt: '2026-11-01T10:00:00.000Z',
  finishedAt: '2026-11-01T10:05:00.000Z',
  cases: [
    {
      id: 'c1',
      title: 'one',
      runs: [
        { outcome: 'met', costUsd: 1 },
        { outcome: 'not_met', costUsd: 2 },
      ],
    },
  ],
});

describe('evals service', () => {
  it('reads committed results, merges the manifest, and refuses a manifest naming an untracked path', async () => {
    repo = createTempRepo();
    const files: Record<string, string> = {
      'evals/reports/chat.answer/20261001T100000000000Z.json': gateReport(true, 0.9),
      'evals/reports/chat.answer/20261002T100000000000Z.json': gateReport(false, 0.4),
      'evals/reports/chat.answer/20261003T100000000000Z.json': '{"not":"a report"}',
      'evals/lane-pipeline/baselines/standard.json': baseline,
      'evals/chat/answer.py': '# eval\n',
      'evals/chat/other.py': '# eval\n',
      'src/chat.py': 'x = 1\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
      writeFileSync(join(repo.path, rel), text);
    }
    // Reports are local output: written to disk, never committed.
    writeFileSync(join(repo.path, '.gitignore'), 'evals/reports/\n');
    const tracked = Object.keys(files).filter((p) => !p.startsWith('evals/reports/'));
    git(repo.path, 'add', '.gitignore', ...tracked);
    git(repo.path, 'commit', '-q', '-m', 'evals');

    const { store, close } = createTestStore();
    closeStore = close;
    const project = seedProject(store, { name: 'p', repoPath: repo.path });
    const evals = createEvalsService({
      state: createStateStore(store, createEventBus()),
      git: createGit({ worktreeRoot: join(repo.path, '..', 'unused') }),
      logger: silentLogger,
    });

    const before = await evals.read(project.id, repo.path);
    expect(before.assessedAt).toBeNull();
    expect(before.gaps).toBeNull();
    expect(before.suites.map((s) => [s.key, s.format, s.runCount, s.latest?.passed])).toEqual([
      ['chat.answer', 'gate_report', 2, false],
      ['lane-pipeline:standard', 'lane_pipeline', 1, false],
    ]);
    expect(before.suites[0]?.latest?.models[0]).toMatchObject({
      model: 'vendor/m',
      slot: 'FAST',
      costUsd: 0.5,
    });
    expect(before.suites[1]?.latest?.models[0]?.gates).toEqual([
      { name: 'c1', rate: 0.5, minimum: 1, passed: false },
    ]);
    expect(before.unlinked).toEqual(['evals/chat/answer.py', 'evals/chat/other.py']);

    const refused = await evals.record(project.id, repo.path, {
      suites: [
        {
          key: 'chat.answer',
          definitionPaths: ['evals/chat/missing.py'],
          coveredPaths: ['nowhere/**'],
        },
      ],
      gaps: [],
    });
    expect(refused).toMatchObject({
      ok: false,
      untracked: ['evals/chat/missing.py', 'nowhere/**'],
    });
    expect((await evals.read(project.id, repo.path)).assessedAt).toBeNull();

    const recorded = await evals.record(project.id, repo.path, {
      suites: [
        {
          key: 'chat.answer',
          label: 'Chat answer',
          definitionPaths: ['evals/chat/answer.py'],
          coveredPaths: ['src/**'],
        },
        { key: 'unrun', definitionPaths: ['evals/chat/other.py'], coveredPaths: [] },
      ],
      gaps: [{ label: 'Summaries', where: 'src/chat.py:1', why: 'no eval' }],
    });
    expect(recorded.ok).toBe(true);
    const after = await evals.read(project.id, repo.path);
    expect(after.unlinked).toEqual([]);
    expect(after.gaps).toHaveLength(1);
    expect(after.suites.map((s) => [s.key, s.label, s.runCount])).toEqual([
      ['chat.answer', 'Chat answer', 2],
      ['lane-pipeline:standard', 'lane-pipeline:standard', 1],
      ['unrun', 'unrun', 0],
    ]);
    const detail = await evals.suite(project.id, repo.path, 'chat.answer', undefined);
    expect(detail.runs.map((r) => r.passed)).toEqual([false, true]);
    expect(detail.coveredPaths).toEqual(['src/**']);
  });

  it('does not read a results folder that links out of the checkout', async () => {
    repo = createTempRepo();
    const outside = tempDir('evals-outside');
    try {
      mkdirSync(join(outside.path, 'chat.answer'), { recursive: true });
      writeFileSync(
        join(outside.path, 'chat.answer', '20261001T100000000000Z.json'),
        gateReport(true, 0.9),
      );
      mkdirSync(join(repo.path, 'evals/chat'), { recursive: true });
      writeFileSync(join(repo.path, 'evals/chat/answer.py'), '# eval\n');
      symlinkSync(outside.path, join(repo.path, 'evals/reports'));
      writeFileSync(join(repo.path, '.gitignore'), 'evals/reports\n');
      git(repo.path, 'add', '.gitignore', 'evals/chat/answer.py');
      git(repo.path, 'commit', '-q', '-m', 'evals');
      const { store, close } = createTestStore();
      closeStore = close;
      const project = seedProject(store, { name: 'p', repoPath: repo.path });
      const evals = createEvalsService({
        state: createStateStore(store, createEventBus()),
        git: createGit({ worktreeRoot: join(repo.path, '..', 'unused') }),
        logger: silentLogger,
      });
      expect((await evals.read(project.id, repo.path)).suites).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });
});
