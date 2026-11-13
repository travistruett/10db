import {
  AnchorResult,
  InvalidError,
  McpToolInputs,
  NotFoundError,
  type ProjectDto,
  type ShapeId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  findDocument,
  getAttachmentRevision,
  getShapeEntry,
  insertAnchorChecks,
  insertGoal,
  insertPerson,
  insertShapeLink,
  insertTask,
  insertWorkstream,
  listShapeProposals,
  patchWorkstream,
  seedProject,
  upsertShapeEntry,
  upsertTaskContext,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { importBundle, planImportChanges } from '../plan-record';
import { createPlanToolHandlers } from './plan-tools';

// A lane's plan tools answer only from its task's Plan: every row reads through the real handlers.

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

/** Imports the fixture, changed by `change`, under its own bundle id. */
function importPlan(id: string, change: (json: Json) => void = () => undefined): ShapeId {
  const json = { ...bundleJson(project.id), id };
  change(json);
  const bundle = parseBundle(json);
  const bodies = inlineBodies(bundle);
  return state.write(
    (ctx) =>
      importBundle(ctx, {
        projectId: project.id,
        bundle,
        bodies,
        changes: planImportChanges(null, bundle, bodies),
      }).shapeId,
  );
}

/** A second revision of p1, so a pinned revision and the latest differ. */
function withRevision2(json: Json): void {
  const [p1] = json['documents'] as { revisions: Json[] }[];
  p1?.revisions.push({
    number: 2,
    body: '# Remote host plan\n## Task 1: Pair a device, again\nRevision two.\n',
    at: '2026-11-13T08:00:00.000Z',
  });
}

function newTask(title: string): TaskId {
  return state.write(
    (ctx) =>
      insertTask(ctx, project.id, {
        title,
        description: '',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      }).id,
  );
}
const workstreamOf = (taskId: TaskId): WorkstreamId =>
  state.write(
    (ctx) =>
      insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }).id,
  );

/** A task pinned to p1's revision 1, task-1, and the handlers its lane gets. */
function pinnedLane(shapeId: ShapeId) {
  const doc = findDocument(store.db, shapeId, 'p1');
  const revision = doc && getAttachmentRevision(store.db, doc.id, 1);
  if (!revision) throw new Error('no p1 revision 1');
  const taskId = newTask('Pair a device');
  state.write((ctx) => {
    upsertTaskContext(ctx, {
      taskId,
      shapeId,
      revisionId: revision.id,
      section: 'task-1',
      shared: [],
      cites: ['f1'],
    });
  });
  return handlersFor(taskId);
}

function handlersFor(taskId: TaskId) {
  const tools = createPlanToolHandlers(store.db, workstreamOf(taskId));
  return {
    section: (input: unknown) =>
      tools.get_plan_section(McpToolInputs.get_plan_section.parse(input)),
    entry: (input: unknown) => tools.get_plan_entry(McpToolInputs.get_plan_entry.parse(input)),
    find: (input: unknown) => tools.find_plan_entries(McpToolInputs.find_plan_entries.parse(input)),
  };
}

describe('the plan tools', () => {
  it('reads its own section at its pinned revision', async () => {
    const lane = pinnedLane(importPlan('plan-a', withRevision2));
    await expect(lane.section({ ref: 'p1#task-1' })).resolves.toEqual({
      ref: 'p1#task-1',
      document: 'p1',
      revision: 1,
      title: 'Task 1: Pair a device',
      text: '## Task 1: Pair a device\nPair it over the tailnet.  \n',
    });
  });

  it('reads the latest revision when asked for another document', async () => {
    const lane = pinnedLane(importPlan('plan-a'));
    await expect(lane.section({ ref: 's1#scope' })).resolves.toMatchObject({
      document: 's1',
      revision: 1,
      text: '## Scope\nPairing only.\n',
    });
  });

  it('an explicit revision reads that one', async () => {
    const lane = pinnedLane(importPlan('plan-a', withRevision2));
    await expect(lane.section({ ref: 'p1#task-1', revision: 2 })).resolves.toMatchObject({
      revision: 2,
      text: '## Task 1: Pair a device, again\nRevision two.\n',
    });
  });

  it('a revision that doesn’t exist is not found', async () => {
    const lane = pinnedLane(importPlan('plan-a'));
    await expect(lane.section({ ref: 'p1#task-1', revision: 9 })).rejects.toThrow(NotFoundError);
  });

  it('two Plans with the same doc and entry keys: each task reads only its own', async () => {
    const a = pinnedLane(importPlan('plan-a'));
    const b = pinnedLane(
      importPlan('plan-b', (json) => {
        const [p1] = json['documents'] as { revisions: Json[] }[];
        const first = p1?.revisions[0];
        if (first) first['body'] = '# B\n## Task 1: Plan B only\nB text.\n## Calls made\nB.\n';
        const [f1] = json['entries'] as Json[];
        if (f1) f1['body'] = { claim: 'Plan B claim' };
      }),
    );
    await expect(a.section({ ref: 'p1#task-1' })).resolves.toMatchObject({
      text: '## Task 1: Pair a device\nPair it over the tailnet.  \n',
    });
    await expect(b.section({ ref: 'p1#task-1' })).resolves.toMatchObject({
      text: '## Task 1: Plan B only\nB text.\n',
    });
    await expect(a.entry({ key: 'f1' })).resolves.toMatchObject({
      body: { claim: 'The runner packs the context once per session.' },
    });
    await expect(b.entry({ key: 'f1' })).resolves.toMatchObject({
      body: { claim: 'Plan B claim' },
    });
  });

  it('a ref to a document only another Plan has is not found', async () => {
    importPlan('plan-b', (json) => {
      (json['documents'] as Json[]).push({
        key: 'p9',
        kind: 'guide',
        title: 'Only in B',
        revisions: [{ number: 1, body: '# Only\n', at: '2026-11-12T08:00:00.000Z' }],
      });
    });
    const a = pinnedLane(importPlan('plan-a'));
    await expect(a.section({ ref: 'p9#only' })).rejects.toThrow(/p9#only/);
  });

  it('get_plan_entry of another Plan’s key is not found', async () => {
    importPlan('plan-b', (json) => {
      (json['entries'] as Json[]).push({
        key: 'only-b',
        kind: 'fact',
        title: 'Only in B',
        body: { claim: 'B' },
        verified: true,
        checkedAt: null,
      });
    });
    const a = pinnedLane(importPlan('plan-a'));
    await expect(a.entry({ key: 'only-b' })).rejects.toThrow(NotFoundError);
  });

  it('find_plan_entries never returns another Plan’s hits', async () => {
    importPlan('plan-b', (json) => {
      (json['entries'] as Json[]).push({
        key: 'zebra-b',
        kind: 'fact',
        title: 'Zebra crossing',
        body: { claim: 'Zebras only in B' },
        verified: true,
        checkedAt: null,
      });
    });
    const a = pinnedLane(importPlan('plan-a'));
    await expect(a.find({ query: 'zebra' })).resolves.toEqual({ hits: [], empty: true });
    const found = await a.find({ query: 'tailnet' });
    expect(found.hits.map((h) => [h.kind, h.key])).toEqual(
      expect.arrayContaining([
        ['experiment', 'x1'],
        ['section', 'p1#task-1'],
      ]),
    );
    const narrow = await a.find({ query: 'tailnet', kinds: ['section'] });
    expect(narrow.hits.every((h) => h.kind === 'section')).toBe(true);
  });

  it('a finding reads by its key and is found by its text, in its own Plan only', async () => {
    importPlan('plan-b', (json) => {
      const [finding] = json['findings'] as Json[];
      json['findings'] = [{ ...finding, key: 'only-b-finding', text: 'Zebras in B' }];
    });
    const a = pinnedLane(importPlan('plan-a'));
    await expect(a.entry({ key: 'p1-r1-1' })).resolves.toEqual({
      kind: 'finding',
      key: 'p1-r1-1',
      document: 'p1',
      revision: 1,
      section: 'task-2',
      reviewer: 'fable plan reviewer',
      severity: 'blocking, security',
      text: 'Revoked devices keep their session',
      state: 'resolved',
    });
    await expect(a.entry({ key: 'only-b-finding' })).rejects.toThrow(NotFoundError);
    const found = await a.find({ query: 'revoked session', kinds: ['finding'] });
    expect(found.hits.map((h) => [h.kind, h.key])).toEqual([['finding', 'p1-r1-1']]);
    await expect(a.find({ query: 'zebras' })).resolves.toEqual({ hits: [], empty: true });
  });

  it('a section hit names its revision, which get_plan_section reads', async () => {
    const lane = pinnedLane(importPlan('plan-a', withRevision2));
    const found = await lane.find({ query: 'again', kinds: ['section'] });
    expect(found.hits.map((h) => [h.key, h.revision])).toEqual([['p1#task-1', 2]]);
    await expect(lane.section({ ref: 'p1#task-1', revision: 2 })).resolves.toMatchObject({
      text: '## Task 1: Pair a device, again\nRevision two.\n',
    });
  });

  it('search reads an entry’s text, never its field names, and snips text, not JSON', async () => {
    const lane = pinnedLane(importPlan('plan-a'));
    await expect(lane.find({ query: 'definition' })).resolves.toEqual({ hits: [], empty: true });
    const found = await lane.find({ query: 'Mac runs', kinds: ['name'] });
    expect(found.hits).toEqual([
      {
        kind: 'name',
        key: 'n1',
        title: 'Host',
        snippet: 'Host type The Mac 10db runs on daemon',
        revision: null,
      },
    ]);
  });

  it('get_plan_entry leaves out checks of an earlier version and checks at an old base', async () => {
    const shapeId = importPlan('plan-a');
    const doc = findDocument(store.db, shapeId, 'p1');
    const revision = doc && getAttachmentRevision(store.db, doc.id, 1);
    const f1 = getShapeEntry(store.db, shapeId, 'f1');
    if (!revision || !f1) throw new Error('no p1 revision 1 or f1');
    const taskId = newTask('Pair a device');
    const workstreamId = workstreamOf(taskId);
    const [oldBase, base] = ['a'.repeat(40), 'b'.repeat(40)];
    state.write((ctx) => {
      upsertTaskContext(ctx, {
        taskId,
        shapeId,
        revisionId: revision.id,
        section: 'task-1',
        shared: [],
        cites: ['f1'],
      });
      const row = (entryVersion: number, checkedCommit: string, line: number) => ({
        workstreamId,
        entryKey: 'f1',
        entryVersion,
        anchorIndex: 0,
        result: AnchorResult.Current,
        line,
        checkedCommit,
        note: null,
      });
      insertAnchorChecks(ctx, taskId, [row(1, base, 1), row(2, oldBase, 2)]);
      upsertShapeEntry(ctx, { ...f1, shapeId, body: { claim: 'The runner packs twice.' } });
      insertAnchorChecks(ctx, taskId, [row(2, base, 3)]);
      patchWorkstream(ctx, workstreamId, null, { baseHead: base });
    });
    const tools = createPlanToolHandlers(store.db, workstreamId);
    const entry = await tools.get_plan_entry(McpToolInputs.get_plan_entry.parse({ key: 'f1' }));
    expect('checks' in entry ? entry.checks.map((c) => c.line) : []).toEqual([3]);
  });

  it('a task with no Plan is told so', async () => {
    const lane = handlersFor(newTask('Plain'));
    await expect(lane.section({ ref: 'p1#task-1' })).rejects.toThrow(InvalidError);
    await expect(lane.entry({ key: 'f1' })).rejects.toThrow('This task has no Plan.');
    await expect(lane.find({ query: 'x' })).rejects.toThrow('This task has no Plan.');
  });

  it('a task made from a Plan without a planRef finds its Plan through its goal’s link', async () => {
    const shapeId = importPlan('plan-a');
    const proposal = listShapeProposals(store.db, shapeId).find((p) => p.key === 'g1');
    if (!proposal) throw new Error('no g1');
    const taskId = state.write((ctx) => {
      const made = insertGoal(ctx, project.id, {
        brief: {
          title: 'Pairing',
          objective: 'A device pairs.',
          tasks: [{ key: 't2', title: 'Revoke a device', areas: ['api'] }],
        },
      });
      insertShapeLink(ctx, { shapeId, proposalId: proposal.id, key: 'g1', goalId: made.goal.id });
      const id = made.taskIds.get('t2');
      if (!id) throw new Error('no t2');
      return id;
    });
    const lane = handlersFor(taskId);
    await expect(lane.section({ ref: 'p1#task-2' })).resolves.toMatchObject({
      revision: 1,
      text: '## Task 2: Revoke a device\r\nRevoke it.\n',
    });
  });

  it('a pending decision reads with its alternatives', async () => {
    const lane = pinnedLane(importPlan('plan-a'));
    await expect(lane.entry({ key: 'd1' })).resolves.toEqual({
      kind: 'decision',
      key: 'd1',
      question: 'Where does the record live?',
      choice: 'In the database',
      rationale: 'Local only',
      alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
      quote: 'Plans never go in the repo.',
      lasting: true,
      state: 'pending',
    });
    await expect(lane.entry({ key: 'q1' })).resolves.toEqual({
      kind: 'question',
      key: 'q1',
      text: 'Which port?',
      for: 'designer',
      blocks: 'P2',
    });
  });
});
