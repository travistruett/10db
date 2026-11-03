import {
  ConflictError,
  InvalidError,
  NotFoundError,
  ShapeFindingState,
  ShapeToolInputs,
  type ShapeToolName,
} from '@10db/contracts';
import {
  listRehearsals,
  listShapeAttachments,
  listShapeFindings,
  listShapeMessages,
  patchShape,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  looseDraft,
  must,
  seedConversation,
  type ConversationFixture,
} from './conversation-fixture';
import { editProposal } from './rounds';
import { rehearsalTasks, unrehearsedTasks } from './review';
import { createShapeToolHandlers } from './tools';

// Shape spec §7: reviewers report findings the session resolves or the builder dismisses; the
// rehearsal marks a task read only on its closing report, at the hash the daemon listed it at.

let c: ConversationFixture;
let state: StateStore;
beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
  state.write((ctx) => {
    patchShape(ctx, c.shape.id, { proposeUnlocked: true });
  });
});
afterEach(() => {
  c.close();
});

const handlers = () => createShapeToolHandlers({ state }, c.shape.id);
/** Calls a tool as the MCP endpoint does: the input parsed with the tool's schema first. */
const call = (name: ShapeToolName, input: unknown): Promise<unknown> => {
  const handler = handlers()[name] as ((i: unknown) => Promise<unknown>) | undefined;
  if (!handler) throw new Error(`no ${name}`);
  return handler(ShapeToolInputs[name].parse(input));
};
const propose = (draft: unknown) => call('propose_plan', { draft });
const findings = () => listShapeFindings(c.store.db, c.shape.id);
const marks = () => listRehearsals(c.store.db, c.shape.id);

function goalDraft(source: string): Record<string, unknown> {
  return {
    goals: [
      {
        key: 'density',
        title: 'Density',
        objective: 'The board is denser.',
        ceremony: 'spec',
        sourceMessageIds: [source],
        tasks: [
          { key: 'cards', title: 'Cards', areas: ['api'], size: 'S' },
          { key: 'bars', title: 'Scrollbars', areas: ['api'], size: 'S' },
        ],
      },
    ],
  };
}

async function planned() {
  const m = c.say();
  await propose({
    ...goalDraft(m),
    ...looseDraft(m, 'abandon'),
  });
  const tasks = rehearsalTasks(c.store.db, c.shape.id);
  const hash = (taskKey: string): string =>
    must(
      tasks.find((t) => t.taskKey === taskKey),
      taskKey,
    ).hash;
  return { m, tasks, hash };
}

describe('report_finding', () => {
  it('is refused for the main session: no reviewer was stamped', async () => {
    await planned();
    await expect(
      call('report_finding', {
        effortKey: 'density',
        finding: { kind: 'finding', severity: 'high', text: 'x' },
      }),
    ).rejects.toThrow(InvalidError);
    expect(findings()).toEqual([]);
  });

  it('keeps a scope reviewer’s finding under the effort, with the round and a line in the transcript', async () => {
    await planned();
    await call('report_finding', {
      effortKey: 'density',
      reviewer: 'scope',
      finding: { kind: 'finding', severity: 'high', text: 'Names no migration' },
    });
    expect(findings()).toMatchObject([
      {
        effortKey: 'density',
        taskKey: null,
        reviewer: 'scope',
        kind: 'finding',
        severity: 'high',
        text: 'Names no migration',
        state: 'open',
        round: 1,
        taskHash: null,
      },
    ]);
    expect(listShapeMessages(c.store.db, c.shape.id).at(-1)?.body).toBe(
      'report_finding · scope · high · density · Names no migration',
    );
  });

  it('stamps the task’s current hash on a finding under one task', async () => {
    const { hash } = await planned();
    await call('report_finding', {
      effortKey: 'density',
      taskKey: 'cards',
      reviewer: 'engineering',
      finding: { kind: 'finding', severity: 'low', text: 'Reuse the card tokens' },
    });
    expect(findings()[0]).toMatchObject({ taskKey: 'cards', taskHash: hash('cards') });
  });

  it.each([
    ['an unknown effort', { effortKey: 'nope' }, /no effort with the key nope/],
    ['an unknown task', { effortKey: 'density', taskKey: 'nope' }, /density has no task nope/],
  ])('refuses %s, naming it', async (_name, where, message) => {
    await planned();
    await expect(
      call('report_finding', {
        ...where,
        reviewer: 'scope',
        finding: { kind: 'finding', severity: 'low', text: 'x' },
      }),
    ).rejects.toThrow(message);
  });

  it.each(['scope', 'engineering'])(
    'has a %s reviewer report findings, not questions',
    async (reviewer) => {
      await planned();
      await expect(
        call('report_finding', {
          effortKey: 'density',
          reviewer,
          finding: { kind: 'question', text: 'Which?' },
        }),
      ).rejects.toThrow(/reports findings/);
    },
  );
});

describe('the rehearsal', () => {
  const ask = (taskKey: string, taskHash: string, text: string, extra: object = {}) =>
    call('report_finding', {
      effortKey: 'density',
      taskKey,
      taskHash,
      reviewer: 'rehearsal',
      finding: { kind: 'question', text },
      ...extra,
    });

  it('reports a question under the task at the hash it read, and marks nothing until it closes', async () => {
    const { hash } = await planned();
    await ask('cards', hash('cards'), 'Card padding, or rows per column?');
    expect(findings()).toMatchObject([
      {
        kind: 'question',
        reviewer: 'rehearsal',
        taskKey: 'cards',
        taskHash: hash('cards'),
        severity: null,
        state: 'open',
      },
    ]);
    expect(marks()).toEqual([]);
  });

  it('marks the task on the closing question, counting what it found', async () => {
    const { hash } = await planned();
    await ask('cards', hash('cards'), 'One?');
    await ask('cards', hash('cards'), 'Two?', { final: true });
    expect(marks().map((m) => [m.taskKey, m.hash, m.questions])).toEqual([
      ['cards', hash('cards'), 2],
    ]);
  });

  it('marks a task with nothing to ask as read, with zero questions', async () => {
    const { hash } = await planned();
    await call('report_finding', {
      effortKey: 'density',
      taskKey: 'bars',
      taskHash: hash('bars'),
      reviewer: 'rehearsal',
      finding: { kind: 'none' },
    });
    expect(findings()).toEqual([]);
    expect(marks().map((m) => [m.taskKey, m.questions])).toEqual([['bars', 0]]);
  });

  it('works for a loose task, whose key is its own task key', async () => {
    const { hash } = await planned();
    await call('report_finding', {
      effortKey: 'abandon',
      taskKey: 'abandon',
      taskHash: hash('abandon'),
      reviewer: 'rehearsal',
      finding: { kind: 'none' },
    });
    expect(marks().map((m) => m.taskKey)).toEqual(['abandon']);
  });

  it('discards a report at a hash the task no longer has: no question, no mark', async () => {
    const { hash } = await planned();
    const stale = hash('cards');
    state.write((ctx) => {
      const row = must(
        rehearsalTasks(ctx.tx, c.shape.id).find((t) => t.taskKey === 'cards'),
        'cards',
      );
      editProposal(ctx, row.proposalId, { 'tasks.cards.title': 'Compact cards' });
    });
    const result = await ask('cards', stale, 'Which padding?', { final: true });
    expect(result).toMatchObject({ discarded: true });
    expect(findings()).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it('does not repeat a question it already asked at the same hash', async () => {
    const { hash } = await planned();
    await ask('cards', hash('cards'), 'Which padding?');
    await ask('cards', hash('cards'), 'Which padding?', { final: true });
    expect(findings()).toHaveLength(1);
    expect(marks()[0]?.questions).toBe(1);
  });

  it('needs a task and the hash it read', async () => {
    const { hash } = await planned();
    await expect(
      call('report_finding', {
        effortKey: 'density',
        reviewer: 'rehearsal',
        finding: { kind: 'none' },
      }),
    ).rejects.toThrow(/names the task/);
    await expect(
      call('report_finding', {
        effortKey: 'density',
        taskKey: 'cards',
        reviewer: 'rehearsal',
        finding: { kind: 'none' },
      }),
    ).rejects.toThrow(/hash/);
    expect(hash('cards')).toBeTruthy();
  });

  it('reports questions or none, not review findings', async () => {
    const { hash } = await planned();
    await expect(
      call('report_finding', {
        effortKey: 'density',
        taskKey: 'cards',
        taskHash: hash('cards'),
        reviewer: 'rehearsal',
        finding: { kind: 'finding', severity: 'low', text: 'x' },
      }),
    ).rejects.toThrow(/questions/);
  });
});

describe('which tasks need a rehearsal', () => {
  it('lists every pending task, a goal’s each, until a closing report marks it at its hash', async () => {
    const { hash } = await planned();
    expect(unrehearsedTasks(c.store.db, c.shape.id).map((t) => t.taskKey)).toEqual([
      'cards',
      'bars',
      'abandon',
    ]);
    await call('report_finding', {
      effortKey: 'density',
      taskKey: 'cards',
      taskHash: hash('cards'),
      reviewer: 'rehearsal',
      finding: { kind: 'none' },
    });
    expect(unrehearsedTasks(c.store.db, c.shape.id).map((t) => t.taskKey)).toEqual([
      'bars',
      'abandon',
    ]);
  });

  it('lists a task again once an edit changed it, and only that task of its goal', async () => {
    const { hash, tasks } = await planned();
    for (const key of ['cards', 'bars', 'abandon'])
      await call('report_finding', {
        effortKey: key === 'abandon' ? 'abandon' : 'density',
        taskKey: key,
        taskHash: hash(key),
        reviewer: 'rehearsal',
        finding: { kind: 'none' },
      });
    expect(unrehearsedTasks(c.store.db, c.shape.id)).toEqual([]);
    state.write((ctx) => {
      editProposal(ctx, must(tasks[0], 'cards').proposalId, {
        'tasks.cards.title': 'Compact cards',
      });
    });
    expect(unrehearsedTasks(c.store.db, c.shape.id).map((t) => t.taskKey)).toEqual(['cards']);
  });

  it('can be narrowed to the proposals the builder selected', async () => {
    const { tasks } = await planned();
    const loose = must(
      tasks.find((t) => t.taskKey === 'abandon'),
      'abandon',
    );
    expect(
      unrehearsedTasks(c.store.db, c.shape.id, [loose.proposalId]).map((t) => t.taskKey),
    ).toEqual(['abandon']);
  });

  it('leaves out a ceremony-only edit: it is not what the implementer reads', async () => {
    const { tasks, hash } = await planned();
    const loose = must(
      tasks.find((t) => t.taskKey === 'abandon'),
      'abandon',
    );
    state.write((ctx) => {
      editProposal(ctx, loose.proposalId, { ceremony: 'spec' });
    });
    expect(rehearsalTasks(c.store.db, c.shape.id).find((t) => t.taskKey === 'abandon')?.hash).toBe(
      hash('abandon'),
    );
  });
});

describe('resolve_finding', () => {
  it('resolves an open finding with a one-line how', async () => {
    await planned();
    await call('report_finding', {
      effortKey: 'density',
      reviewer: 'scope',
      finding: { kind: 'finding', severity: 'high', text: 'Names no migration' },
    });
    const id = must(findings()[0], 'finding').id;
    await call('resolve_finding', { findingId: id, how: 'Added a migration task' });
    expect(findings()[0]).toMatchObject({
      state: ShapeFindingState.Resolved,
      how: 'Added a migration task',
    });
    await expect(call('resolve_finding', { findingId: id, how: 'again' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('knows no finding of another conversation', async () => {
    await planned();
    await expect(
      call('resolve_finding', { findingId: 'shf_00000000-0000-7000-8000-000000000000', how: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('write_spec', () => {
  it('keeps an effort’s spec, replacing the earlier one', async () => {
    await planned();
    await call('write_spec', { effortKey: 'density', markdown: '# v1' });
    await call('write_spec', { effortKey: 'density', markdown: '# v2' });
    expect(
      listShapeAttachments(c.store.db, c.shape.id).map((a) => [a.kind, a.key, a.body]),
    ).toEqual([['spec', 'density', '# v2']]);
  });

  it('refuses an effort that is not in the plan, naming it', async () => {
    await planned();
    await expect(call('write_spec', { effortKey: 'nope', markdown: '# x' })).rejects.toThrow(
      /no effort with the key nope/,
    );
  });
});
