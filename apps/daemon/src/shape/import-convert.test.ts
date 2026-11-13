import {
  ShapeProposalBody,
  ShapeProposalState,
  type PlanBundle,
  type ProjectDto,
  type ShapeId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  getTask,
  insertPerson,
  insertWorkstream,
  listShapeLinks,
  listShapeProposals,
  patchTask,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { importBundle, loadStoredRecord, planImportChanges, validateBundle } from '../plan-record';
import { convertProposals } from './convert';

// An imported Plan converts like any other, and a re-import after Convert proposes changes and
// additions against what Convert made, never edits it, and says what it left alone.

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

function importInto(bundle: PlanBundle) {
  return state.write((ctx) => {
    const bodies = inlineBodies(bundle);
    const stored = loadStoredRecord(ctx.tx, project.id, bundle.id);
    const issues = validateBundle({
      bundle,
      bodies,
      projectId: project.id,
      areaNames: new Set(project.areas.map((a) => a.name)),
      stored,
    });
    if (issues.length > 0) throw new Error(issues.map((i) => i.message).join('; '));
    const changes = planImportChanges(stored, bundle, bodies);
    return importBundle(ctx, { projectId: project.id, bundle, bodies, changes });
  });
}

/** Converts every pending proposal of the Plan, failing the test on a refusal. */
function convertAll(shapeId: ShapeId) {
  return state.write((ctx) => {
    const ids = listShapeProposals(ctx.tx, shapeId)
      .filter((p) => p.state === ShapeProposalState.Pending)
      .map((p) => p.id);
    const outcome = convertProposals(ctx, shapeId, ids);
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    return outcome;
  });
}

const taskOf = (shapeId: ShapeId, key: string) => {
  const id = listShapeLinks(store.db, shapeId).find((l) => l.key === key)?.taskId;
  if (!id) throw new Error(`no task ${key}`);
  return id;
};

type Json = Record<string, unknown>;

/** The fixture with no task pinned to a section, for the rows that don't read pins. */
function unpinned(): Json {
  const json = bundleJson(project.id);
  for (const goal of json['goals'] as { tasks: Json[] }[])
    for (const task of goal.tasks) {
      delete task['planRef'];
      delete task['cites'];
    }
  return json;
}
const goalTasks = (b: Json, goal: number) => (b['goals'] as { tasks: Json[] }[])[goal]?.tasks ?? [];

describe('an imported Plan through Convert', () => {
  it('a goal task depending on another goal’s task imports and converts', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const t1 = taskOf(shapeId, 't1');
    expect(getTask(store.db, taskOf(shapeId, 't3')).dependsOn).toEqual([t1]);
    expect(getTask(store.db, taskOf(shapeId, 't2')).dependsOn).toEqual([t1]);
  });

  it('re-import after Convert proposes change:<taskId> for a changed task and an addition for a new one, and leaves a dropped one alone', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const next = unpinned();
    const g1 = goalTasks(next, 0);
    if (g1[1]) g1[1]['title'] = 'Revoke a device at once';
    g1.push({ key: 't5', title: 'Rename a device', criteria: ['Renamed'], areas: ['api'] });
    next['tasks'] = [];
    const again = importInto(parseBundle(next));
    const t2 = taskOf(shapeId, 't2');
    expect(again.changes.proposals.changeTasks).toEqual([`change:${t2}`]);
    expect(again.changes.proposals.additions).toEqual(['t5']);
    expect(again.changes.proposals.leftAlone).toEqual([
      { key: 't4', why: 't4 is no longer in the bundle; remove it by hand if it should go' },
    ]);
    const rows = listShapeProposals(store.db, shapeId);
    const change = rows.find((r) => r.key === `change:${t2}`);
    expect(change && ShapeProposalBody.change_task.parse(change.body)).toMatchObject({
      taskId: t2,
      title: 'Revoke a device at once',
    });
    const added = rows.find((r) => r.key === 't5');
    expect(added && ShapeProposalBody.task.parse(added.body).goalId).toBeDefined();
    expect(getTask(store.db, t2).title).toBe('Revoke a device');
    // Converting the change and the addition lands them; a third import then has nothing to do.
    convertAll(shapeId);
    expect(getTask(store.db, t2).title).toBe('Revoke a device at once');
    const third = importInto(parseBundle(next));
    expect(third.changes.proposals).toMatchObject({ changeTasks: [], additions: [], added: [] });
  });

  it('a builder’s board edit is never proposed back, and the same bundle again writes nothing', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const t1 = taskOf(shapeId, 't1');
    store.write((ctx) => patchTask(ctx, t1, { title: 'Pair a device, my way' }));
    const before = listShapeProposals(store.db, shapeId);
    const again = importInto(parseBundle(unpinned()));
    expect(again.changes.proposals).toMatchObject({ changeTasks: [], leftAlone: [] });
    expect(listShapeProposals(store.db, shapeId)).toEqual(before);
    expect(getTask(store.db, t1).title).toBe('Pair a device, my way');
  });

  it('a bundle change change_task cannot carry is named, once', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const next = unpinned();
    const [t1] = goalTasks(next, 0);
    if (t1) {
      t1['headline'] = 'Pairing, in a line';
      t1['size'] = 'L';
    }
    const again = importInto(parseBundle(next));
    expect(again.changes.proposals.changeTasks).toEqual([]);
    expect(again.changes.proposals.leftAlone).toEqual([
      { key: 't1', why: "t1's headline, size changed after Convert: edit the task on the board" },
    ]);
    expect(importInto(parseBundle(next)).changes.proposals.leftAlone).toEqual([]);
  });

  it('a second change before Convert keeps the first in the same change proposal', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const t2 = taskOf(shapeId, 't2');
    const next = unpinned();
    const g1 = goalTasks(next, 0);
    if (g1[1]) g1[1]['title'] = 'Revoke a device at once';
    importInto(parseBundle(next));
    if (g1[1]) g1[1]['description'] = 'Revoke it now.';
    importInto(parseBundle(next));
    const change = listShapeProposals(store.db, shapeId).find((r) => r.key === `change:${t2}`);
    expect(change && ShapeProposalBody.change_task.parse(change.body)).toMatchObject({
      title: 'Revoke a device at once',
      description: 'Revoke it now.',
    });
  });

  it('re-import after a task started leaves it alone and says why', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const t1 = taskOf(shapeId, 't1');
    store.write((ctx) =>
      insertWorkstream(ctx, t1, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    const next = unpinned();
    const g1 = goalTasks(next, 0);
    if (g1[0]) g1[0]['title'] = 'Pair a device, renamed';
    const again = importInto(parseBundle(next));
    expect(again.changes.proposals.changeTasks).toEqual([]);
    expect(again.changes.proposals.leftAlone).toEqual([
      { key: 't1', why: 't1 has started, so its change (title) is left alone' },
    ]);
    expect(getTask(store.db, t1).title).toBe('Pair a device');
  });

  it('re-import of a changed decision after Convert leaves it alone and says to supersede it', () => {
    const { shapeId } = importInto(parseBundle(unpinned()));
    convertAll(shapeId);
    const next = unpinned();
    const decisions = next['decisions'] as Json[];
    if (decisions[0]) decisions[0]['choice'] = 'In a sync';
    const again = importInto(parseBundle(next));
    expect(again.changes.proposals.leftAlone).toEqual([
      { key: 'd1', why: 'd1 changed after Convert: supersede it in Knowledge' },
    ]);
    expect(again.changes.proposals.replaced).toEqual([]);
  });
});
