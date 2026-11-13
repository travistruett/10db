import {
  AnchorResult,
  ShapeProposalState,
  type ProjectDto,
  type ShapeId,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  findDocument,
  getAttachmentRevision,
  getShapeEntry,
  getWorkstreamRow,
  insertAnchorChecks,
  insertPerson,
  insertTask,
  insertWorkstream,
  listShapeProposals,
  patchShapeProposal,
  patchWorkstream,
  seedProject,
  transitionWorkstream,
  upsertTaskContext,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { importBundle, planImportChanges } from './import';
import { loadStoredRecord } from './lookup';
import { buildPlanContext } from './plan-context';

let store: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  project = seedProject(store, { name: 'alpha' });
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
});
afterEach(() => {
  close();
});

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

/** A task pinned to a section of p1's first revision, citing `cites`, and its first workstream. */
function pinnedTask(
  shapeId: ShapeId,
  section: string,
  cites: string[],
  shared: string[] = ['calls-made'],
): { taskId: TaskId; workstream: WorkstreamDto } {
  const doc = findDocument(store.db, shapeId, 'p1');
  const revision = doc && getAttachmentRevision(store.db, doc.id, 1);
  if (!revision) throw new Error('no p1 revision 1');
  const taskId = state.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Pair a device',
      description: '',
      acceptanceCriteria: ['A device pairs'],
      areas: ['api'],
    });
    upsertTaskContext(ctx, {
      taskId: task.id,
      shapeId,
      revisionId: revision.id,
      section,
      shared,
      cites,
    });
    return task.id;
  });
  return { taskId, workstream: newWorkstream(taskId) };
}

function newWorkstream(taskId: TaskId): WorkstreamDto {
  return state.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  );
}

function endWorkstream(ws: WorkstreamDto): void {
  state.write((ctx) => {
    transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null });
    transitionWorkstream(ctx, ws.id, { to: 'FAILED', fence: null });
  });
}

const check = (
  ws: WorkstreamDto,
  commit: string,
  over: Partial<Parameters<typeof insertAnchorChecks>[2][number]> = {},
) => ({
  workstreamId: ws.id,
  entryKey: 'f1',
  entryVersion: 1,
  anchorIndex: 0,
  result: AnchorResult.Current,
  line: 3,
  checkedCommit: commit,
  note: null,
  ...over,
});

/** The workstream with its row's base set, as the runner's session write sets it. */
function at(ws: WorkstreamDto, base: string): WorkstreamDto {
  state.write((ctx) => {
    patchWorkstream(ctx, ws.id, null, { baseHead: base });
  });
  return ws;
}
const f1Checks = (ws: WorkstreamDto, base?: string) =>
  buildPlanContext(store.db, ws, base === undefined ? {} : { base })?.facts.find(
    (f) => f.key === 'f1',
  )?.checks ?? [];

describe('buildPlanContext', () => {
  it('a task with no context has no plan', () => {
    const taskId = state.write(
      (ctx) =>
        insertTask(ctx, project.id, {
          title: 'Plain',
          description: '',
          acceptanceCriteria: ['x'],
          areas: ['api'],
        }).id,
    );
    expect(buildPlanContext(store.db, newWorkstream(taskId))).toBeNull();
  });

  it('the section and shared sections are always whole, even past the budget', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { workstream } = pinnedTask(shapeId, 'task-1', ['f1', 'd1', 'i1']);
    const plan = buildPlanContext(store.db, workstream, { budgetTokens: 1 });
    expect(plan?.section).toEqual({
      ref: 'p1#task-1',
      text: '## Task 1: Pair a device\nPair it over the tailnet.  \n',
    });
    expect(plan?.shared).toEqual([
      { ref: 'p1#calls-made', text: '## Calls made\nSettings › Sharing is where it lives.\n' },
    ]);
    expect(plan?.notIncluded).toEqual(['d1', 'f1', 'i1']);
    expect(plan).toMatchObject({ budget: 1, used: 0, title: 'Remote host' });
    expect(plan?.goal).toBeNull();
  });

  it('cited items fill 6,000 tokens in order and the rest are named, and a smaller later item still fits', () => {
    const json = bundleJson(project.id);
    const big = (key: string) => ({
      key,
      kind: 'fact',
      title: key,
      body: { claim: `${key} `.repeat(4150) },
      verified: true,
      checkedAt: null,
    });
    json['entries'] = [...(json['entries'] as Json[]), big('b1'), big('b2'), big('b3')];
    const shapeId = importJson(json);
    const { workstream } = pinnedTask(shapeId, 'task-1', ['b1', 'b2', 'b3', 'f1', 'd1']);
    const plan = buildPlanContext(store.db, workstream);
    expect(plan?.decisions.map((d) => d.key)).toEqual(['d1']);
    expect(plan?.facts.map((f) => f.key)).toEqual(['b1', 'f1']);
    expect(plan?.notIncluded).toEqual(['b2', 'b3']);
    expect(plan?.budget).toBe(6000);
    expect(plan?.used).toBeLessThanOrEqual(6000);
    expect(plan?.used).toBeGreaterThan(3000);
  });

  it('only open findings on the task’s section are listed', () => {
    const json = bundleJson(project.id);
    const [resolved] = json['findings'] as Json[];
    json['findings'] = [
      { ...resolved, key: 'open-2', state: 'open' },
      { ...resolved, key: 'closed-2' },
      { ...resolved, key: 'open-1', section: 'task-1', state: 'open' },
    ];
    const shapeId = importJson(json);
    const { workstream } = pinnedTask(shapeId, 'task-2', []);
    expect(buildPlanContext(store.db, workstream)?.findings).toEqual([
      { key: 'open-2', severity: 'blocking, security', text: 'Revoked devices keep their session' },
    ]);
  });

  it('a cited fact the re-import superseded and a dropped decision are marked as such', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { workstream } = pinnedTask(shapeId, 'task-1', ['f1', 'd1']);
    const next = bundleJson(project.id);
    next['entries'] = (next['entries'] as Json[]).filter((e) => e['key'] !== 'f1');
    importJson(next);
    const d1 = listShapeProposals(store.db, shapeId).find((r) => r.key === 'd1');
    if (!d1) throw new Error('no d1');
    state.write((ctx) => {
      patchShapeProposal(ctx, d1.id, { state: ShapeProposalState.Rejected });
    });
    const plan = buildPlanContext(store.db, workstream);
    expect(plan?.facts).toMatchObject([{ key: 'f1', dropped: 'superseded' }]);
    expect(plan?.decisions).toMatchObject([{ key: 'd1', dropped: 'rejected' }]);
  });

  it('an entry versioned after Convert is read at its current version', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { workstream } = pinnedTask(shapeId, 'task-1', ['f1']);
    const next = bundleJson(project.id);
    const [f1] = next['entries'] as Json[];
    if (f1) f1['body'] = { claim: 'The runner packs twice.' };
    importJson(next);
    expect(buildPlanContext(store.db, workstream)?.facts).toMatchObject([
      { key: 'f1', version: 2, line: 'The runner packs twice.' },
    ]);
  });

  it('checks from an earlier workstream of the task are not used', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { taskId, workstream: first } = pinnedTask(shapeId, 'task-1', ['f1']);
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(first, 'aaaaaaa')]);
    });
    expect(f1Checks(at(first, 'aaaaaaa'))).toHaveLength(1);
    endWorkstream(first);
    const second = newWorkstream(taskId);
    expect(f1Checks(at(second, 'aaaaaaa'))).toEqual([]);
  });

  it('a check of the fact’s earlier version is not used after a re-import moves its anchor', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { taskId, workstream } = pinnedTask(shapeId, 'task-1', ['f1']);
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(workstream, 'aaaaaaa')]);
    });
    const next = bundleJson(project.id);
    const [f1] = next['entries'] as Json[];
    if (f1)
      f1['anchors'] = [
        { kind: 'code', path: 'src/moved.ts', line: 9, commit: '818d3644', excerpt: 'pack()' },
      ];
    importJson(next);
    expect(getShapeEntry(store.db, shapeId, 'f1')?.version).toBe(2);
    const plan = buildPlanContext(store.db, at(workstream, 'aaaaaaa'));
    expect(plan?.facts[0]).toMatchObject({
      version: 2,
      anchors: [{ path: 'src/moved.ts', line: 9 }],
      checks: [],
    });
  });

  it('a check at the old base is not used after the base moved', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { taskId, workstream } = pinnedTask(shapeId, 'task-1', ['f1']);
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(workstream, 'aaaaaaa')]);
    });
    expect(f1Checks(at(workstream, 'aaaaaaa'))).toHaveLength(1);
    expect(f1Checks(at(workstream, 'bbbbbbb'))).toEqual([]);
  });

  it('a first session, whose row has no base yet, uses the base the runner passes', () => {
    const shapeId = importJson(bundleJson(project.id));
    const { taskId, workstream } = pinnedTask(shapeId, 'task-1', ['f1']);
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [
        check(workstream, 'aaaaaaa', { result: AnchorResult.Moved, line: 6 }),
      ]);
    });
    expect(getWorkstreamRow(store.db, workstream.id).baseHead).toBeNull();
    expect(f1Checks(workstream)).toEqual([]);
    expect(f1Checks(workstream, 'aaaaaaa')).toMatchObject([{ result: 'moved', line: 6 }]);
  });
});
