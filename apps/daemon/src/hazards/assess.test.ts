import {
  createTestStore,
  getProject,
  readHazardAssessment,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { Git } from '../git';
import { pendingHazardRemovals } from '../inbox';
import { silentLogger } from '../log';
import { createHazardAssessor, type HazardAssessor } from './assess';

let store: Store;
let close: () => void;
let state: StateStore;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
});
afterEach(() => {
  close();
  vi.useRealTimers();
});

const MAKEFILE = [
  'gate:',
  '\tmake lint',
  'migration:',
  '\tdocker compose run backend python manage.py makemigrations $(APP)',
  'backend-lock:',
  '\tdocker compose run backend uv lock',
].join('\n');
const AGENTS = ['# amps', 'Use `python3 amps/dev_export.py` to refresh exports.'].join('\n');

const FILES: Record<string, string> = {
  Makefile: MAKEFILE,
  'amps/AGENTS.md': AGENTS,
  'amps/backend/uv.lock': 'x',
};

const git = {
  survey: () => Promise.resolve({ files: Object.keys(FILES), commits: [] }),
  commitAt: () => Promise.resolve('c0ffee'),
  fileAt: (_repo: string, _rev: string, path: string) =>
    Promise.resolve(
      FILES[path] === undefined
        ? { kind: 'missing' as const }
        : { kind: 'file' as const, text: FILES[path] },
    ),
} as unknown as Git;

const logger = silentLogger;

const ANSWER = JSON.stringify({
  additions: [
    {
      hazard: 'migrations',
      kind: 'command',
      value: 'make migration',
      reason: 'Creates a migration.',
      file: 'Makefile',
      line: 3,
    },
    {
      hazard: 'deps',
      kind: 'command',
      value: 'make backend-lock',
      reason: 'Locks the backend.',
      file: 'Makefile',
      line: 5,
    },
    {
      hazard: 'exports',
      kind: 'command',
      value: 'python3 amps/dev_export.py',
      reason: 'Rewrites exports.',
      file: 'amps/AGENTS.md',
      line: 2,
    },
    {
      hazard: 'exports',
      kind: 'glob',
      value: 'amps/backend/uv.lock',
      reason: 'Backend lock.',
      file: 'amps/backend/uv.lock',
    },
    {
      hazard: 'migrations',
      kind: 'command',
      value: 'make gate',
      reason: 'The gate.',
      file: 'Makefile',
      line: 1,
    },
  ],
  removals: [],
});

function assessor(
  asker: ((prompt: string, signal?: AbortSignal) => Promise<string>) | null,
  askMs = 5_000,
): HazardAssessor {
  return createHazardAssessor({ state, git, asker, logger, askMs });
}

const seed = () => seedProject(store, { gateCommand: 'make gate', repoPath: '/tmp/ampsio' });

describe('assessing a project from its repository', () => {
  it('saves the additions that pass the checks, each with its evidence, and not the gate', async () => {
    const project = seed();
    const prompts: string[] = [];
    const outcome = await assessor((prompt) => {
      prompts.push(prompt);
      return Promise.resolve(ANSWER);
    }).assess(project.id);
    expect(outcome).toMatchObject({ ok: true, added: 4 });
    // The repository's text reaches the model as numbered lines.
    expect(prompts[0]).toContain('3: migration:');
    const hazards = getProject(store.db, project.id).hazards;
    expect(hazards.find((h) => h.name === 'migrations')?.commands).toContain('make migration');
    expect(hazards.find((h) => h.name === 'migrations')?.commands).not.toContain('make gate');
    expect(hazards.find((h) => h.name === 'deps')?.commands).toContain('make backend-lock');
    expect(hazards.find((h) => h.name === 'exports')?.globs).toEqual(['amps/backend/uv.lock']);
    const read = readHazardAssessment(store.db, project.id);
    expect(read.commit).toBe('c0ffee');
    expect(read.additions.map((a) => a.evidence)).toEqual([
      { file: 'Makefile', line: 3 },
      { file: 'Makefile', line: 5 },
      { file: 'amps/AGENTS.md', line: 2 },
      { file: 'amps/backend/uv.lock' },
    ]);
  });

  it('changes nothing when the model is unavailable, fails, answers badly or is too slow', async () => {
    const project = seed();
    const before = JSON.stringify(getProject(store.db, project.id).hazards);
    const cases: ((prompt: string, signal?: AbortSignal) => Promise<string>)[] = [
      () => Promise.reject(new Error('no account')),
      () => Promise.resolve('I cannot say.'),
      () => new Promise(() => undefined),
    ];
    for (const asker of cases) {
      const outcome = await assessor(asker, 20).assess(project.id);
      expect(outcome.ok).toBe(false);
    }
    expect((await assessor(null).assess(project.id)).ok).toBe(false);
    expect(JSON.stringify(getProject(store.db, project.id).hazards)).toBe(before);
    expect(readHazardAssessment(store.db, project.id).assessedAt).toBeNull();
  });

  it('raises one card for a proposed removal and leaves the hazard as it is', async () => {
    const project = seed();
    const asker = () =>
      Promise.resolve(
        JSON.stringify({
          additions: [],
          removals: [
            {
              hazard: 'deps',
              kind: 'command',
              value: 'yarn add',
              reason: 'The repo uses uv.',
              file: 'Makefile',
              line: 6,
            },
          ],
        }),
      );
    const outcome = await assessor(asker).assess(project.id);
    expect(outcome).toMatchObject({ ok: true, added: 0, removals: 1 });
    expect(pendingHazardRemovals(store.db, project.id)).toHaveLength(1);
    expect(
      getProject(store.db, project.id).hazards.find((h) => h.name === 'deps')?.commands,
    ).toContain('yarn add');
  });

  it('proposes removing an addition whose evidence has gone, and still applies nothing', async () => {
    const project = seed();
    await assessor(() => Promise.resolve(ANSWER)).assess(project.id);
    FILES['Makefile'] = 'gate:\n\tmake lint\n';
    try {
      const outcome = await assessor(() =>
        Promise.resolve('{"additions":[],"removals":[]}'),
      ).assess(project.id);
      expect(outcome).toMatchObject({ ok: true, added: 0 });
      const pending = pendingHazardRemovals(store.db, project.id);
      expect(pending.map((p) => p.value).sort()).toEqual(['make backend-lock', 'make migration']);
      expect(
        getProject(store.db, project.id).hazards.find((h) => h.name === 'deps')?.commands,
      ).toContain('make backend-lock');
    } finally {
      FILES['Makefile'] = MAKEFILE;
    }
  });

  it('joins a look already running instead of asking the model twice', async () => {
    const project = seed();
    let asked = 0;
    let release: (text: string) => void = () => undefined;
    const slow = () => {
      asked += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const a = assessor(slow);
    const first = a.assess(project.id);
    const second = a.assess(project.id);
    await vi.waitFor(() => {
      expect(asked).toBe(1);
    });
    release(ANSWER);
    expect(await first).toEqual(await second);
    expect(asked).toBe(1);
  });

  it('asks again later for a project a commit changed, once for a burst of commits', async () => {
    vi.useFakeTimers();
    const project = seed();
    let asked = 0;
    const a = assessor(() => {
      asked += 1;
      return Promise.resolve(ANSWER);
    });
    a.schedule(project.id);
    a.schedule(project.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBe(1);
    a.stop();
  });
});
