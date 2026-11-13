import {
  ConversationItemId,
  EventType,
  idUuid,
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
  getConversation,
  getShape,
  getShapeSdkSessionId,
  getSession,
  insertConversation,
  insertItem,
  insertPrinciple,
  insertSession,
  insertShape,
  insertShadowAnswer,
  insertShapeLink,
  insertShapeMessage,
  insertShapeProposal,
  insertShapeQuestion,
  insertSource,
  insertTask,
  insertWorkstream,
  listShapeLinks,
  listShapeMessages,
  listShapeQuestions,
  listShapes,
  markShapeLinksSizeTold,
  patchShape,
  seedProject,
  shapeConversation,
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

function laneSession(hash = 'hash-lane') {
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Lane work',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const session = insertSession(ctx, {
      ...sessionInput,
      workstreamId: insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }).id,
      mcpTokenHash: hash,
    });
    return { session, taskId: task.id };
  }).value;
}

describe('the Shape tables', () => {
  it.each([
    ['shapes', ['id', 'project_id', 'title', 'state', 'origin', 'propose_unlocked', 'round']],
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
    [
      'conversations',
      [
        'id',
        'project_id',
        'owner_kind',
        'owner_id',
        'profile',
        'account_id',
        'model',
        'provider_session_id',
        'state',
        'next_seq',
      ],
    ],
  ])('%s exists with its columns', (table, expected) => {
    expect(columns(table)).toEqual(expect.arrayContaining(expected));
  });

  it('keeps a conversation’s session and model on its conversation, not on the shape', () => {
    expect(columns('shapes')).not.toContain('sdk_session_id');
    expect(columns('shapes')).not.toContain('model');
  });

  it('adds no Shape column to proposals and no Shape value to ProposalKind', () => {
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
      // M3 knowledge's link to a proposed principle, not Shape's (migration 0037).
      'principle_id',
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
      model: null,
    });
    expect(events.map((e) => e.type)).toEqual([EventType.ShapeChanged]);
    expect(getShape(store.db, shape.id)).toEqual(shape);
    expect(listShapes(store.db, project.id)).toEqual([shape]);
  });

  it('gives a new shape its conversation, which holds the model and the session it resumes', () => {
    const { value: shape } = newShape();
    const conversation = shapeConversation(store.db, shape.id);
    expect(conversation).toMatchObject({
      projectId: project.id,
      ownerKind: 'shape',
      ownerId: shape.id,
      profile: 'explore',
      state: 'idle_cold',
      accountId: project.accountId,
      model: null,
      providerSessionId: null,
    });
    store.write((ctx) =>
      patchShape(ctx, shape.id, { model: 'claude-opus-5-5', sdkSessionId: 'sdk-9' }),
    );
    expect(getShape(store.db, shape.id).model).toBe('claude-opus-5-5');
    expect(getShapeSdkSessionId(store.db, shape.id)).toBe('sdk-9');
    expect(getConversation(store.db, conversation.id)).toMatchObject({
      model: 'claude-opus-5-5',
      providerSessionId: 'sdk-9',
    });
  });

  it('keeps the model the builder chose for a conversation, and forgets it for the default', () => {
    const { value: shape } = newShape();
    store.write((ctx) => patchShape(ctx, shape.id, { model: 'fable' }));
    expect(getShape(store.db, shape.id).model).toBe('fable');
    store.write((ctx) => patchShape(ctx, shape.id, { model: null }));
    expect(getShape(store.db, shape.id).model).toBeNull();
  });

  it('lists a migrated row first and new ones after it, by seq, though new ids sort first', () => {
    const shape = newShape().value;
    const conversation = shapeConversation(store.db, shape.id).id;
    const migrated = ConversationItemId.parse(`shm_${idUuid(mintId('ConversationItem'))}`);
    store.db.$client
      .prepare(
        `INSERT INTO conversation_items (id, conversation_id, seq, author, kind, body, delivered_at, created_at,
           updated_at)
         VALUES (?, ?, 1, 'builder', 'message', '{"text":"old"}', ?, ?, ?)`,
      )
      .run(migrated, conversation, ...Array<string>(3).fill('2026-11-01T00:00:00.000Z'));
    store.db.$client
      .prepare('UPDATE conversations SET next_seq = 2 WHERE id = ?')
      .run(conversation);
    const say = (body: string) =>
      store.write((ctx) =>
        insertShapeMessage(ctx, shape.id, { author: 'builder', kind: 'text', body }),
      ).value;
    const first = say('one');
    const second = say('two');
    expect(listShapeMessages(store.db, shape.id).map((m) => [m.id, m.body])).toEqual([
      [migrated, 'old'],
      [first.id, 'one'],
      [second.id, 'two'],
    ]);
    expect(
      store.db.$client
        .prepare('SELECT seq FROM conversation_items WHERE id = ?')
        .pluck()
        .get(first.id),
    ).toBe(2);
    expect(listShapeMessages(store.db, shape.id, migrated).map((m) => m.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('keeps a tool line of 150 emoji whole', () => {
    const shape = newShape().value;
    const line = '🙂'.repeat(150);
    store.write((ctx) =>
      insertShapeMessage(ctx, shape.id, { author: 'claude', kind: 'tool', body: line }),
    );
    expect(listShapeMessages(store.db, shape.id).map((m) => [m.kind, m.body])).toEqual([
      ['tool', line],
    ]);
  });

  it('logs a shadow answer on a message of the conversation', () => {
    const shape = newShape().value;
    const message = store.write((ctx) =>
      insertItem(ctx, shapeConversation(ctx.tx, shape.id).id, {
        author: 'builder',
        kind: 'message',
        body: { text: 'hi' },
      }),
    ).value;
    store.db.$client.pragma('foreign_keys = ON');
    expect(() =>
      store.write((ctx) => {
        insertShadowAnswer(ctx, {
          shapeId: shape.id,
          messageId: message.id,
          decision: 'shape_ready',
          answer: 'yes',
          confidence: 0.9,
          judgeCallId: mintId('JudgeCall'),
        });
      }),
    ).not.toThrow();
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

  it('stores a question under its task and links a question and a principle through shape_links', () => {
    const shape = newShape().value;
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    const proposal = (key: string, kind: 'question' | 'principle') => {
      const id = mintId('ShapeProposal');
      store.db
        .insert(schema.shapeProposals)
        .values({
          id,
          shapeId: shape.id,
          key,
          kind,
          state: 'accepted',
          round: 1,
          body: {},
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      return id;
    };
    const questionProposal = proposal('who-pays', 'question');
    const principleProposal = proposal('never-sleep', 'principle');
    const { question, principle } = store.write((ctx) => {
      const q = insertShapeQuestion(ctx, {
        shapeId: shape.id,
        proposalId: questionProposal,
        key: 'who-pays',
        text: 'Who pays for the extra seats?',
        forWho: 'finance',
        sourceMessageIds: [],
        taskId: task.id,
      });
      insertShapeLink(ctx, {
        shapeId: shape.id,
        proposalId: questionProposal,
        key: 'who-pays',
        questionId: q.id,
      });
      const p = insertPrinciple(ctx, {
        target: { scope: 'project', projectId: project.id },
        statement: 'Never sleep in tests',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: 'me',
      });
      insertShapeLink(ctx, {
        shapeId: shape.id,
        proposalId: principleProposal,
        key: 'never-sleep',
        principleId: p.id,
      });
      return { question: q, principle: p };
    }).value;
    expect(listShapeQuestions(store.db, shape.id)).toMatchObject([
      { id: question.id, forWho: 'finance', taskId: task.id, goalId: null },
    ]);
    expect(
      listShapeLinks(store.db, shape.id).map((l) => [l.key, l.questionId, l.principleId]),
    ).toEqual([
      ['who-pays', question.id, null],
      ['never-sleep', null, principle.id],
    ]);
  });
});

describe('a Shape session', () => {
  const plan = (shapeId: ReturnType<typeof newShape>['value']['id']) =>
    shapeConversation(store.db, shapeId).id;

  it('belongs to its conversation, on the project account, with no workstream', () => {
    const shape = newShape().value;
    const conversationId = plan(shape.id);
    const session = store.write((ctx) =>
      insertSession(ctx, { ...sessionInput, conversationId, mcpTokenHash: 'hash-shape' }),
    ).value;
    expect(getSession(store.db, session.id)).toMatchObject({
      conversationId,
      workstreamId: null,
      accountId: project.accountId,
      sequence: 1,
    });
    const next = store.write((ctx) =>
      insertSession(ctx, { ...sessionInput, conversationId, mcpTokenHash: 'hash-shape-2' }),
    ).value;
    expect(next.sequence).toBe(2);
  });

  it('is counted in per-project usage once, whichever owners its row names', () => {
    const lane = laneSession();
    const shape = newShape().value;
    const talk = store.write((ctx) =>
      insertSession(ctx, {
        ...sessionInput,
        conversationId: plan(shape.id),
        mcpTokenHash: 'hash-shape',
      }),
    ).value;
    // A lane of a task with a thread names its workstream and its task's conversation.
    const both = laneSession('hash-both');
    const thread = store.write((ctx) =>
      insertConversation(ctx, {
        projectId: project.id,
        owner: { kind: 'task', id: both.taskId },
        profile: 'lane',
        state: null,
      }),
    ).value;
    store.db.$client
      .prepare('UPDATE sessions SET conversation_id = ? WHERE id = ?')
      .run(thread.id, both.session.id);
    store.write((ctx) => {
      updateSessionUsage(ctx, lane.session.id, {
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 1,
      });
      updateSessionUsage(ctx, talk.id, { inputTokens: 40, outputTokens: 4, cachedTokens: 2 });
      updateSessionUsage(ctx, both.session.id, { inputTokens: 7, outputTokens: 1 });
    });
    const usage = accountUsage(store.db, project.accountId, NOVEMBER);
    expect(usage.byProject).toEqual([
      expect.objectContaining({
        projectId: project.id,
        tokensIn: 147,
        tokensOut: 15,
        tokensCached: 3,
      }),
    ]);
    expect(usage.total.tokensIn).toBe(147);
  });

  it('adds up the input and output tokens of every session of its conversation, and no other', () => {
    const lane = laneSession();
    const shape = newShape().value;
    const other = newShape().value;
    expect(shapeTokens(store.db, shape.id)).toBe(0);
    store.write((ctx) => {
      const session = (shapeId: typeof shape.id, hash: string) =>
        insertSession(ctx, { ...sessionInput, conversationId: plan(shapeId), mcpTokenHash: hash });
      const first = session(shape.id, 'hash-tokens-1');
      const second = session(shape.id, 'hash-tokens-2');
      const elsewhere = session(other.id, 'hash-tokens-3');
      updateSessionUsage(ctx, lane.session.id, { inputTokens: 1000, outputTokens: 100 });
      updateSessionUsage(ctx, first.id, { inputTokens: 40, outputTokens: 4, cachedTokens: 9 });
      updateSessionUsage(ctx, second.id, { inputTokens: 60, outputTokens: 6 });
      updateSessionUsage(ctx, elsewhere.id, { inputTokens: 7, outputTokens: 7 });
    });
    expect(shapeTokens(store.db, shape.id)).toBe(110);
    expect(shapeTokens(store.db, other.id)).toBe(14);
  });

  it.each([
    ['neither a workstream nor a conversation', false, true],
    ['both a workstream and a conversation', true, false],
  ])('a session with %s: refused %s', (_, both, refused) => {
    const lane = laneSession();
    const shape = newShape().value;
    const [workstreamId, conversationId] = both
      ? [lane.session.workstreamId, plan(shape.id)]
      : [null, null];
    const insert = () =>
      store.db.$client
        .prepare(
          `INSERT INTO sessions (id, workstream_id, conversation_id, account_id, sequence, provider, model,
             effort, mode, mcp_token_hash, started_at, input_tokens, output_tokens, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'claude', 'opus', 'high', 'managed', 'hash-x', ?, 0, 0, ?, ?)`,
        )
        .run(
          mintId('Session'),
          workstreamId,
          conversationId,
          project.accountId,
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
        );
    if (refused) expect(insert).toThrow(/CHECK constraint failed: sessions_has_owner/);
    else expect(insert).not.toThrow();
  });
});
