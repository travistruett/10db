import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto, ShapeId, TaskId, WorkstreamDto } from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  findDocument,
  getAttachmentRevision,
  insertPerson,
  insertTask,
  insertWorkstream,
  listAnchorChecks,
  listEventsAfter,
  seedProject,
  transitionWorkstream,
  upsertTaskContext,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { ANCHOR_FILE_MAX_BYTES, checkTaskAnchors } from './anchor-check';
import { importBundle, planImportChanges } from './import';
import { loadStoredRecord } from './lookup';

// Every row reads a real git repository: a stale anchor shown as current is the failure guarded.

let store: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
let repo: TempDir;
const git = createGit();

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  project = seedProject(store, { name: 'alpha' });
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
  // The template repository has maintenance, gc and receive-pack's gc turned off already.
  repo = createTempRepo();
});
afterEach(() => {
  repo.cleanup();
  close();
});

const run = (...args: string[]): string =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** Writes the files and commits them, answering the commit. */
function commit(files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    const full = join(repo.path, path);
    if (text === null) rmSync(full, { force: true });
    else {
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, text);
    }
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'change', '--allow-empty');
  return run('rev-parse', 'HEAD');
}

/** The fixture's f1 anchor: `const pack = build();` at line 3 of src/runner.ts. */
const RUNNER = ['// runner', '', 'const pack = build();', 'emit(pack);', ''].join('\n');

type Json = Record<string, unknown>;
function importJson(json: Json): ShapeId {
  const bundle = parseBundle(json);
  const bodies = inlineBodies(bundle);
  return state.write(
    (ctx) =>
      importBundle(ctx, {
        projectId: project.id,
        bundle,
        bodies,
        changes: planImportChanges(loadStoredRecord(ctx.tx, project.id, bundle.id), bundle, bodies),
      }).shapeId,
  );
}

function pinned(shapeId: ShapeId, cites: string[] = ['f1']): { taskId: TaskId; ws: WorkstreamDto } {
  const doc = findDocument(store.db, shapeId, 'p1');
  const revision = doc && getAttachmentRevision(store.db, doc.id, 1);
  if (!revision) throw new Error('no revision');
  const taskId = state.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Pair',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    upsertTaskContext(ctx, {
      taskId: task.id,
      shapeId,
      revisionId: revision.id,
      section: 'task-1',
      shared: [],
      cites,
    });
    return task.id;
  });
  return { taskId, ws: newWorkstream(taskId) };
}
const newWorkstream = (taskId: TaskId): WorkstreamDto =>
  state.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  );

const checkAt = (taskId: TaskId, ws: WorkstreamDto, rev: string) =>
  checkTaskAnchors({ git, state }, { workstreamId: ws.id, taskId, repo: repo.path, rev });
const rows = (ws: WorkstreamDto, rev: string) =>
  listAnchorChecks(store.db, ws.id, rev).map((r) => ({
    entryKey: r.entryKey,
    entryVersion: r.entryVersion,
    result: r.result,
    line: r.line,
    note: r.note,
  }));

/** One fixture Plan and a task citing f1, with the repo at `files`; answers the commit. */
async function checked(files: Record<string, string | null>) {
  const shapeId = importJson(bundleJson(project.id));
  const { taskId, ws } = pinned(shapeId);
  const rev = commit(files);
  const count = await checkAt(taskId, ws, rev);
  return { shapeId, taskId, ws, rev, count };
}

describe('checkTaskAnchors', () => {
  it.each([
    ['an untouched file is current', { 'src/runner.ts': RUNNER }, 'current', 3],
    [
      'lines added above make it moved with the new line',
      { 'src/runner.ts': `a\nb\nc\n${RUNNER}` },
      'moved',
      6,
    ],
    [
      'an edited excerpt is changed',
      { 'src/runner.ts': RUNNER.replace('build()', 'build(now)') },
      'changed',
      null,
    ],
  ] as const)('%s', async (_, files, result, line) => {
    const { ws, rev, count } = await checked(files);
    expect(count).toBe(1);
    expect(rows(ws, rev)).toEqual([{ entryKey: 'f1', entryVersion: 1, result, line, note: null }]);
  });

  it('a deleted file is changed', async () => {
    commit({ 'src/runner.ts': RUNNER });
    const { ws, rev } = await checked({ 'src/runner.ts': null });
    expect(rows(ws, rev)).toMatchObject([{ result: 'changed', line: null }]);
  });

  it('a renamed file is changed', async () => {
    commit({ 'src/runner.ts': RUNNER });
    const { ws, rev } = await checked({ 'src/runner.ts': null, 'src/lane.ts': RUNNER });
    expect(rows(ws, rev)).toMatchObject([{ result: 'changed' }]);
  });

  it('a path that is a link in the commit is changed', async () => {
    commit({ 'src/real.ts': RUNNER });
    symlinkSync('real.ts', join(repo.path, 'src', 'runner.ts'));
    const { ws, rev } = await checked({});
    expect(rows(ws, rev)).toMatchObject([{ result: 'changed', line: null }]);
  });

  it('a file over the cap is unchecked', async () => {
    const { ws, rev } = await checked({
      'src/runner.ts': RUNNER + 'x'.repeat(ANCHOR_FILE_MAX_BYTES),
    });
    expect(rows(ws, rev)).toEqual([
      {
        entryKey: 'f1',
        entryVersion: 1,
        result: 'unchecked',
        line: null,
        note: 'the file is over 4 MiB',
      },
    ]);
  });

  it('a commit git doesn’t have is unchecked, never current', async () => {
    const shapeId = importJson(bundleJson(project.id));
    const { taskId, ws } = pinned(shapeId);
    const missing = 'deadbeef'.repeat(5);
    await checkAt(taskId, ws, missing);
    const [row] = rows(ws, missing);
    expect(row?.result).toBe('unchecked');
    expect(row?.note).toBeTruthy();
  });

  it('a url anchor is url and nothing is fetched', async () => {
    const fetched = vi.fn(() => {
      throw new Error('no network in this test');
    });
    vi.stubGlobal('fetch', fetched);
    try {
      const json = bundleJson(project.id);
      const [f1] = json['entries'] as Json[];
      if (f1)
        f1['anchors'] = [
          { kind: 'url', url: 'https://tailscale.com/kb/1312', readAt: '2026-11-12' },
        ];
      const shapeId = importJson(json);
      const { taskId, ws } = pinned(shapeId);
      const rev = commit({});
      await checkAt(taskId, ws, rev);
      expect(rows(ws, rev)).toMatchObject([{ result: 'url', line: null }]);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a second call for the same workstream and base writes nothing', async () => {
    const { taskId, ws, rev } = await checked({ 'src/runner.ts': RUNNER });
    const before = listEventsAfter(store.db, 0, 10_000).length;
    expect(await checkAt(taskId, ws, rev)).toBe(0);
    expect(listEventsAfter(store.db, 0, 10_000)).toHaveLength(before);
    expect(rows(ws, rev)).toHaveLength(1);
  });

  it('a new workstream of the same task checks again', async () => {
    const { taskId, ws, rev } = await checked({ 'src/runner.ts': RUNNER });
    state.write((ctx) => {
      transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null });
      transitionWorkstream(ctx, ws.id, { to: 'FAILED', fence: null });
    });
    const next = newWorkstream(taskId);
    expect(await checkAt(taskId, next, rev)).toBe(1);
    expect(rows(next, rev)).toMatchObject([{ result: 'current' }]);
  });

  it('a base moved forward checks again at the new commit, and the old rows stay as they were', async () => {
    const { taskId, ws, rev } = await checked({ 'src/runner.ts': RUNNER });
    const moved = commit({ 'src/runner.ts': `a\nb\nc\n${RUNNER}` });
    expect(await checkAt(taskId, ws, moved)).toBe(1);
    expect(rows(ws, moved)).toMatchObject([{ result: 'moved', line: 6 }]);
    expect(rows(ws, rev)).toMatchObject([{ result: 'current', line: 3 }]);
  });

  it('a cited fact versioned by re-import checks its new anchor', async () => {
    const { taskId, ws, rev } = await checked({
      'src/runner.ts': RUNNER,
      'src/lane.ts': `x\n${RUNNER}`,
    });
    const next = bundleJson(project.id);
    const [f1] = next['entries'] as Json[];
    if (f1)
      f1['anchors'] = [
        {
          kind: 'code',
          path: 'src/lane.ts',
          line: 4,
          commit: '818d3644',
          excerpt: 'const pack = build();',
        },
      ];
    importJson(next);
    expect(await checkAt(taskId, ws, rev)).toBe(1);
    expect(rows(ws, rev)).toEqual([
      { entryKey: 'f1', entryVersion: 1, result: 'current', line: 3, note: null },
      { entryKey: 'f1', entryVersion: 2, result: 'current', line: 4, note: null },
    ]);
  });

  it('a task without a plan writes nothing', async () => {
    const taskId = state.write(
      (ctx) =>
        insertTask(ctx, project.id, {
          title: 'Plain',
          description: '',
          acceptanceCriteria: ['x'],
          areas: ['api'],
        }).id,
    );
    const ws = newWorkstream(taskId);
    const before = listEventsAfter(store.db, 0, 10_000).length;
    expect(await checkAt(taskId, ws, commit({}))).toBe(0);
    expect(listEventsAfter(store.db, 0, 10_000)).toHaveLength(before);
  });
});
