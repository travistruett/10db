import {
  EventType,
  mintId,
  ProposalKind,
  ShapeOrigin,
  ShapeProposalKind,
  ShapeProposalState,
  ShapeState,
  type ProjectDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  accountUsage,
  createTestStore,
  getShape,
  getSession,
  insertSession,
  insertShape,
  insertShapeLink,
  insertShapeProposal,
  insertTask,
  insertWorkstream,
  listShapeLinks,
  listShapes,
  markShapeLinksSizeTold,
  seedProject,
  shapeTokens,
  updateSessionUsage,
  type Store,
} from './index';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §5.1, §6 Rows, §13.

let store: Store;
let close: () => void;
let now: Date;
let project: ProjectDto;
beforeEach(() => {
  now = new Date(2026, 10, 2, 12, 0);
  ({ store, close } = createTestStore(() => now));
  project = seedProject(store, { name: 'alpha' });
});
afterEach(() => {
  close();
});

const NOVEMBER = {
  month: '2026-11',
  start: new Date(2026, 10, 1).toISOString(),
  end: new Date(2026, 11, 1).toISOString(),
};

const columns = (table: string): unknown[] =>
  store.db.$client.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table);

const sessionInput = {
  provider: 'claude',
  model: 'opus',
  effort: 'high',
  mode: 'managed',
} as const;

function newShape(title = 'Density') {
  return store.write((ctx) => insertShape(ctx, project.id, { title, origin: ShapeOrigin.App }));
}

function laneSession() {
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Lane work',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    return insertSession(ctx, {
      ...sessionInput,
      workstreamId: insertWorkstream(ctx, task.id).id,
      mcpTokenHash: 'hash-lane',
    });
  }).value;
}

describe('the Shape tables', () => {
  it.each([
    [
      'shapes',
      [
        'id',
        'project_id',
        'title',
        'state',
        'origin',
        'sdk_session_id',
        'propose_unlocked',
        'round',
      ],
    ],
    ['shape_messages', ['id', 'shape_id', 'author', 'kind', 'body', 'created_at']],
    [
      'shape_proposals',
      [
        'id',
        'shape_id',
        'key',
        'kind',
        'state',
        'round',
        'pinned',
        'body',
        'task_hashes',
        'source_message_ids',
      ],
    ],
    ['shape_links', ['id', 'shape_id', 'proposal_id', 'key', 'goal_id', 'task_id', 'decision_id']],
  ])('%s exists with its columns', (table, expected) => {
    expect(columns(table)).toEqual(expect.arrayContaining(expected));
  });

  it('leaves proposals and ProposalKind as they were', () => {
    expect(columns('proposals')).toEqual([
      'id',
      'project_id',
      'kind',
      'title',
      'body',
      'status',
      'rationale',
      'source_id',
      'created_at',
      'updated_at',
    ]);
    expect(Object.values(ProposalKind)).toEqual(['new_task', 'change_task', 'principle', 'note']);
  });

  it('writes a listening conversation, announces it and reads it back', () => {
    const { value: shape, events } = newShape();
    expect(shape).toMatchObject({
      projectId: project.id,
      title: 'Density',
      state: ShapeState.Listening,
      origin: ShapeOrigin.App,
      proposeUnlocked: false,
      round: 0,
    });
    expect(events.map((e) => e.type)).toEqual([EventType.ShapeChanged]);
    expect(getShape(store.db, shape.id)).toEqual(shape);
    expect(listShapes(store.db, project.id)).toEqual([shape]);
  });

  it('keeps one proposal per key in a conversation', () => {
    const shape = newShape().value;
    const insert = () =>
      store.db
        .insert(schema.shapeProposals)
        .values({
          id: mintId('ShapeProposal'),
          shapeId: shape.id,
          key: 'density',
          kind: 'goal',
          state: 'pending',
          round: 1,
          body: {},
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it('links a proposal to exactly one created goal, task or decision', () => {
    const shape = newShape().value;
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    const proposalId = mintId('ShapeProposal');
    store.db
      .insert(schema.shapeProposals)
      .values({
        id: proposalId,
        shapeId: shape.id,
        key: 'thin-scrollbars',
        kind: 'task',
        state: 'accepted',
        round: 1,
        body: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();
    const link = (target: { taskId?: typeof task.id; goalId?: null }) =>
      store.db
        .insert(schema.shapeLinks)
        .values({
          id: mintId('ShapeLink'),
          shapeId: shape.id,
          proposalId,
          key: 'thin-scrollbars',
          ...target,
          createdAt: now.toISOString(),
        })
        .run();
    expect(() => link({})).toThrow(/CHECK/);
    expect(() => link({ taskId: task.id })).not.toThrow();
  });

  it('marks a link told once, keeping its first time, and leaves the others alone', () => {
    const shape = newShape().value;
    const taskInput = { acceptanceCriteria: ['x'], areas: ['api'] };
    const links = store.write((ctx) => {
      const row = insertShapeProposal(ctx, {
        shapeId: shape.id,
        key: 'a',
        kind: ShapeProposalKind.Task,
        state: ShapeProposalState.Accepted,
        round: 1,
        createdRound: 1,
        pinned: [],
        body: {},
        taskHashes: {},
        sourceMessageIds: [],
      });
      return ['a', 'b'].map((key) =>
        insertShapeLink(ctx, {
          shapeId: shape.id,
          proposalId: row.id,
          key,
          taskId: insertTask(ctx, project.id, { ...taskInput, title: key }).id,
        }),
      );
    }).value;
    const told = () => listShapeLinks(store.db, shape.id).map((l) => l.sizeToldAt);
    const first = links[0]?.id;
    if (first === undefined) throw new Error('no link');
    expect(told()).toEqual([null, null]);

    store.write((ctx) => {
      markShapeLinksSizeTold(ctx, []);
      markShapeLinksSizeTold(ctx, [first]);
    });
    const at = now.toISOString();
    expect(told()).toEqual([at, null]);

    now = new Date(now.getTime() + 60_000);
    store.write((ctx) => {
      markShapeLinksSizeTold(ctx, [first]);
    });
    expect(told()).toEqual([at, null]);
  });
});

describe('a Shape session', () => {
  it('belongs to its conversation, on the project account, with no workstream', () => {
    const shape = newShape().value;
    const session = store.write((ctx) =>
      insertSession(ctx, { ...sessionInput, shapeId: shape.id, mcpTokenHash: 'hash-shape' }),
    ).value;
    expect(getSession(store.db, session.id)).toMatchObject({
      shapeId: shape.id,
      workstreamId: null,
      accountId: project.accountId,
      sequence: 1,
    });
    const next = store.write((ctx) =>
      insertSession(ctx, { ...sessionInput, shapeId: shape.id, mcpTokenHash: 'hash-shape-2' }),
    ).value;
    expect(next.sequence).toBe(2);
  });

  it('is counted in per-project usage beside the lanes', () => {
    const lane = laneSession();
    const shape = newShape().value;
    const talk = store.write((ctx) =>
      insertSession(ctx, { ...sessionInput, shapeId: shape.id, mcpTokenHash: 'hash-shape' }),
    ).value;
    store.write((ctx) => {
      updateSessionUsage(ctx, lane.id, { inputTokens: 100, outputTokens: 10, cachedTokens: 1 });
      updateSessionUsage(ctx, talk.id, { inputTokens: 40, outputTokens: 4, cachedTokens: 2 });
    });
    const usage = accountUsage(store.db, project.accountId, NOVEMBER);
    expect(usage.byProject).toEqual([
      expect.objectContaining({
        projectId: project.id,
        tokensIn: 140,
        tokensOut: 14,
        tokensCached: 3,
      }),
    ]);
    expect(usage.total.tokensIn).toBe(140);
  });

  it('adds up the input and output tokens of every session of its conversation, and no other', () => {
    const lane = laneSession();
    const shape = newShape().value;
    const other = newShape().value;
    expect(shapeTokens(store.db, shape.id)).toBe(0);
    store.write((ctx) => {
      const session = (shapeId: typeof shape.id, hash: string) =>
        insertSession(ctx, { ...sessionInput, shapeId, mcpTokenHash: hash });
      const first = session(shape.id, 'hash-tokens-1');
      const second = session(shape.id, 'hash-tokens-2');
      const elsewhere = session(other.id, 'hash-tokens-3');
      updateSessionUsage(ctx, lane.id, { inputTokens: 1000, outputTokens: 100 });
      updateSessionUsage(ctx, first.id, { inputTokens: 40, outputTokens: 4, cachedTokens: 9 });
      updateSessionUsage(ctx, second.id, { inputTokens: 60, outputTokens: 6 });
      updateSessionUsage(ctx, elsewhere.id, { inputTokens: 7, outputTokens: 7 });
    });
    expect(shapeTokens(store.db, shape.id)).toBe(110);
    expect(shapeTokens(store.db, other.id)).toBe(14);
  });

  it.each([
    ['neither a workstream nor a shape', false],
    ['both a workstream and a shape', true],
  ])('is refused by the database with %s', (_, both) => {
    const lane = laneSession();
    const shape = newShape().value;
    const [workstreamId, shapeId] = both ? [lane.workstreamId, shape.id] : [null, null];
    expect(() =>
      store.db.$client
        .prepare(
          `INSERT INTO sessions (id, workstream_id, shape_id, account_id, sequence, provider, model, effort,
             mode, mcp_token_hash, started_at, input_tokens, output_tokens, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'claude', 'opus', 'high', 'managed', 'hash-x', ?, 0, 0, ?, ?)`,
        )
        .run(
          mintId('Session'),
          workstreamId,
          shapeId,
          project.accountId,
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });
});
