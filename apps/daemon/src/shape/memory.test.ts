import {
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeToolInputs,
  type DecisionId,
  type ProjectId,
} from '@10db/contracts';
import {
  findRecords,
  getDecision,
  insertDecision,
  insertPrinciple,
  insertSource,
  listShapeMessages,
  listShapeProposals,
  searchDecisions,
  seedProject,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { convertProposals } from './convert';
import { reconcileDraft } from './rounds';
import { createShapeToolHandlers } from './tools';

// Shape spec §5.5 Remembering, §10.1 Supersede, §15 memory: find_records finds a recorded decision
// with its date and never another project's; a record that supersedes it converts with
// supersedes_id set, and the old one leaves search.

let c: ConversationFixture;
let state: StateStore;
let nowMs: number;
beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
  nowMs = Date.parse('2026-10-30T09:00:00.000Z');
});
afterEach(() => {
  c.close();
});

function decide(projectId: ProjectId | null, question: string, choice: string): DecisionId {
  return c.store.write((ctx) =>
    insertDecision(
      { ...ctx, now: new Date(nowMs).toISOString() },
      {
        projectId,
        question,
        choice,
        rationale: 'Because.',
        decidedBy: 'me',
        scope: projectId === null ? 'you' : 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      },
    ),
  ).value;
}

const findRecordsTool = async (query: string): Promise<unknown> => {
  const handler = must(createShapeToolHandlers({ state }, c.shape.id).find_records, 'find_records');
  return handler(ShapeToolInputs.find_records.parse({ query }));
};

describe('find_records', () => {
  it('surfaces a contradicting decision with its date, and cites it in the chat', async () => {
    const id = decide(c.project.id, 'Which board density?', 'Comfortable rows only');
    const other = seedProject(c.store, { name: 'beta' });
    decide(other.id, 'Which board density for beta?', 'Compact');

    const result = (await findRecordsTool('board density')) as { records: unknown[] };
    expect(result.records).toEqual([
      expect.objectContaining({
        id,
        choice: 'Comfortable rows only',
        createdAt: '2026-10-30T09:00:00.000Z',
      }),
    ]);
    const lines = listShapeMessages(c.store.db, c.shape.id).filter(
      (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Tool,
    );
    expect(lines.map((m) => m.body)).toEqual([
      'find_records · Decided 2026-10-30: Which board density? Comfortable rows only',
    ]);
  });

  it('surfaces a principle with its kind, key, scope and date, and cites it in the chat', async () => {
    const principle = c.store.write((ctx) =>
      insertPrinciple(
        { ...ctx, now: new Date(nowMs).toISOString() },
        {
          target: { scope: 'project', projectId: c.project.id },
          statement: 'Never sleep in tests',
          kind: 'policy',
          topicKey: 'tests.no-sleeps',
          status: 'confirmed',
          sourceId: insertSource(ctx, 'builder', {}),
          sourceQuote: null,
          speaker: 'me',
          confirmedBy: 'me',
        },
      ),
    ).value;
    const result = (await findRecordsTool('sleep')) as { records: unknown[] };
    expect(result.records).toEqual([
      expect.objectContaining({
        kind: 'principle',
        id: principle.id,
        principleKind: 'policy',
        topicKey: 'tests.no-sleeps',
        scope: 'project',
        createdAt: '2026-10-30T09:00:00.000Z',
      }),
    ]);
    expect(listShapeMessages(c.store.db, c.shape.id).map((m) => m.body)).toEqual([
      'find_records · Principle 2026-10-30 (policy, tests.no-sleeps): Never sleep in tests',
    ]);
  });

  it('says so when nothing was decided', async () => {
    expect(await findRecordsTool('anything')).toEqual({ records: [] });
    expect(listShapeMessages(c.store.db, c.shape.id).map((m) => m.body)).toEqual([
      'find_records · nothing recorded',
    ]);
  });

  it('includes builder-wide decisions', async () => {
    const id = decide(null, 'Which density everywhere?', 'Comfortable');
    const result = (await findRecordsTool('density')) as { records: { id: string }[] };
    expect(result.records.map((r) => r.id)).toEqual([id]);
  });
});

describe('a record that supersedes a decision', () => {
  it('converts with supersedes_id set, and the old decision leaves find_records and search', () => {
    const old = decide(c.project.id, 'Which board density?', 'Comfortable rows only');
    const m = c.say('Actually, compact rows are fine now.');
    const draft = PlanDraft.parse({
      records: [
        {
          key: 'density',
          kind: 'decision',
          scope: 'project',
          question: 'Which board density?',
          choice: 'Compact rows',
          rationale: 'The board got crowded.',
          supersedes: old,
          sourceMessageIds: [m],
        },
      ],
    });
    c.store.write((ctx) => {
      const out = reconcileDraft(ctx, c.shape.id, draft);
      if (!out.ok) throw new Error(out.errors.join('; '));
    });
    const row = must(
      listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'density'),
      'row',
    );
    const converted = c.store.write((ctx) => convertProposals(ctx, c.shape.id, [row.id])).value;
    if (!converted.ok) throw new Error(converted.errors.join('; '));
    const created = must(converted.results[0]?.decisionId, 'decision');

    expect(getDecision(c.store.db, created).supersedesId).toBe(old);
    expect(findRecords(c.store.db, c.project.id, 'board density', 10).map((r) => r.id)).toEqual([
      created,
    ]);
    expect(searchDecisions(c.store.db, c.project.id, 'board density', 10).map((r) => r.id)).toEqual(
      [created],
    );
  });
});
