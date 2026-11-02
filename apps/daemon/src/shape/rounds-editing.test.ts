import { PlanDraft, ShapeProposalState } from '@10db/contracts';
import { listShapeProposals, type WriteContext } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  looseDraft,
  must,
  seedConversation,
  type ConversationFixture,
} from './conversation-fixture';
import {
  dropProposal,
  editProposal,
  reconcileDraft,
  restoreProposal,
  unpinProposal,
  type ProposeOutcome,
} from './rounds';

// Shape spec §6 Editing and Rounds: an edit pins, a later round keeps the pin, Restore pins a row
// back, Drop tombstones its key, and a row's round says what the latest round did to it.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const propose = (draft: Record<string, unknown>): ProposeOutcome =>
  c.store.write((ctx) => reconcileDraft(ctx, c.shape.id, PlanDraft.parse(draft))).value;
const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;
const row = (key: string) => {
  const found = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

/** A draft of one goal with two tasks, `edit` applied to the first task. */
function goalDraft(source: string, edit: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goals: [
      {
        key: 'density',
        title: 'Density',
        objective: 'The board is denser.',
        ceremony: 'direct',
        sourceMessageIds: [source],
        tasks: [
          { key: 'cards', title: 'Cards', areas: ['api'], size: 'S', ...edit },
          { key: 'bars', title: 'Scrollbars', areas: ['api'], size: 'S' },
        ],
      },
    ],
  };
}

describe('the round a row carries', () => {
  it('is the round that created it, and stays put while rounds restate it unchanged', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    propose(looseDraft(m, 'a'));
    propose(looseDraft(m, 'a'));
    expect(row('a')).toMatchObject({ round: 1, createdRound: 1 });
  });

  it('moves to the round that changed it, and keeps the round that created it', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    propose(looseDraft(m, 'a'));
    const next = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
    next.looseTasks[0] = { ...next.looseTasks[0], size: 'M' };
    propose(next);
    expect(row('a')).toMatchObject({ round: 3, createdRound: 1 });
  });

  it('does not count a change in the sources alone', () => {
    const m = c.say();
    const later = c.say('And a second thing.');
    propose(looseDraft(m, 'a'));
    propose(looseDraft(later, 'a'));
    expect(row('a').round).toBe(1);
  });

  it('does not count a change in the order of a list', () => {
    const m = c.say();
    const draft = (areas: string[], criteria: string[]) => {
      const d = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
      d.looseTasks[0] = { ...d.looseTasks[0], areas, criteria };
      return d;
    };
    propose(draft(['api', 'ui'], ['One', 'Two']));
    propose(draft(['ui', 'api'], ['Two', 'One']));
    expect(row('a').round).toBe(1);
  });

  it('does not count a goal’s tasks coming in another order', () => {
    const m = c.say();
    propose(goalDraft(m));
    const reordered = goalDraft(m) as { goals: { tasks: unknown[] }[] };
    reordered.goals[0]?.tasks.reverse();
    propose(reordered);
    expect(row('density').round).toBe(1);
  });

  it('counts a changed task inside a goal as the goal changing', () => {
    const m = c.say();
    propose(goalDraft(m));
    propose(goalDraft(m, { size: 'M' }));
    expect(row('density')).toMatchObject({ round: 2, createdRound: 1 });
    expect(row('density').taskHashes['cards']?.changedFields).toEqual(['size']);
    expect(row('density').taskHashes['bars']?.changedFields).toEqual([]);
  });

  it('takes a row Earlier in the round that left it out, and brings it back changed', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    propose(looseDraft(m, 'a'));
    expect(row('b')).toMatchObject({ state: ShapeProposalState.Superseded, round: 2 });
    propose(looseDraft(m, 'a', 'b'));
    expect(row('b')).toMatchObject({
      state: ShapeProposalState.Pending,
      round: 3,
      createdRound: 1,
    });
  });
});

describe('editing a goal’s task', () => {
  it('pins the task’s field by its path, so a later round changes its siblings but not it', () => {
    const m = c.say();
    propose(goalDraft(m));
    write((ctx) => {
      editProposal(ctx, row('density').id, { 'tasks.cards.size': 'L' });
    });
    expect(row('density').pinned).toEqual(['tasks.cards.size']);
    const tasks = (key: string) =>
      (row(key).body as { tasks: { key: string; size: string; title: string }[] }).tasks;
    expect(tasks('density').find((t) => t.key === 'cards')?.size).toBe('L');

    // Claude's next round retitles both tasks and resizes both.
    const next = goalDraft(m, { size: 'M', title: 'Cards, tighter' }) as {
      goals: { tasks: Record<string, unknown>[] }[];
    };
    const goal = must(next.goals[0], 'the goal');
    goal.tasks[1] = { ...goal.tasks[1], size: 'M', title: 'Thin bars' };
    propose(next);
    expect(tasks('density').find((t) => t.key === 'cards')).toMatchObject({
      size: 'L',
      title: 'Cards, tighter',
    });
    expect(tasks('density').find((t) => t.key === 'bars')).toMatchObject({
      size: 'M',
      title: 'Thin bars',
    });
  });

  it('keeps a pinned task a later round leaves out of its goal, and says so', () => {
    const m = c.say();
    propose(goalDraft(m));
    write((ctx) => {
      editProposal(ctx, row('density').id, { 'tasks.cards.size': 'L' });
    });

    // Claude's next round splits `cards` into two tasks, leaving the pinned one out.
    const next = goalDraft(m) as { goals: { tasks: Record<string, unknown>[] }[] };
    const goal = must(next.goals[0], 'the goal');
    goal.tasks = [
      { key: 'cards-a', title: 'Cards, half', areas: ['api'], size: 'S' },
      { key: 'cards-b', title: 'Cards, other half', areas: ['api'], size: 'S' },
      { key: 'bars', title: 'Scrollbars', areas: ['api'], size: 'S' },
    ];
    expect(propose(next)).toMatchObject({ ok: true, kept: ['density.tasks.cards'] });

    const tasks = (row('density').body as { tasks: { key: string; size: string }[] }).tasks;
    expect(tasks.map((t) => t.key).sort()).toEqual(['bars', 'cards', 'cards-a', 'cards-b']);
    expect(tasks.find((t) => t.key === 'cards')?.size).toBe('L');
    expect(row('density').pinned).toEqual(['tasks.cards.size']);
  });

  it('refuses a task the goal does not have, changing nothing', () => {
    const m = c.say();
    propose(goalDraft(m));
    expect(() => {
      write((ctx) => {
        editProposal(ctx, row('density').id, { 'tasks.nope.size': 'L' });
      });
    }).toThrow(/nope/);
    expect(row('density').pinned).toEqual([]);
  });

  it('refuses an edit that makes the row invalid, changing nothing', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    expect(() => {
      write((ctx) => {
        editProposal(ctx, row('a').id, { size: 'XXL' });
      });
    }).toThrow(/does not fit/);
    expect(row('a').pinned).toEqual([]);
  });
});

describe('unpinning', () => {
  it('lets a later round change the field again', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      editProposal(ctx, row('a').id, { title: 'Mine' });
      unpinProposal(ctx, row('a').id, 'title');
    });
    expect(row('a').pinned).toEqual([]);
    const next = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
    next.looseTasks[0] = { ...next.looseTasks[0], title: 'Claude’s' };
    propose(next);
    expect(row('a').body).toMatchObject({ title: 'Claude’s' });
  });

  it('with no field, lets go of a restored row as a whole', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      restoreProposal(ctx, row('b').id);
      unpinProposal(ctx, row('b').id);
    });
    expect(row('b').pinned).toEqual([]);
    expect(propose(looseDraft(m, 'a'))).toMatchObject({ ok: true, superseded: ['b'] });
  });

  it('refuses a field that is not pinned', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    expect(() => {
      write((ctx) => {
        unpinProposal(ctx, row('a').id, 'title');
      });
    }).toThrow(/not pinned/);
  });
});

describe('Restore', () => {
  it('brings a row back from Earlier without the "changed" mark of the round that moved it', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      restoreProposal(ctx, row('b').id);
    });
    expect(row('b')).toMatchObject({
      state: ShapeProposalState.Pending,
      pinned: ['*'],
      round: 1,
      createdRound: 1,
    });
  });

  it('pins a pending row as a whole too', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      restoreProposal(ctx, row('a').id);
    });
    expect(row('a').pinned).toEqual(['*']);
  });

  it('refuses a dropped row: a drop is for good', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      dropProposal(ctx, row('a').id);
    });
    expect(() => {
      write((ctx) => {
        restoreProposal(ctx, row('a').id);
      });
    }).toThrow(/dropped/);
    expect(row('a').state).toBe(ShapeProposalState.Rejected);
  });
});

describe('Drop', () => {
  it('keeps the dropped row as a tombstone and refuses its key from then on', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    write((ctx) => {
      dropProposal(ctx, row('b').id);
    });
    expect(row('b').state).toBe(ShapeProposalState.Rejected);
    const out = propose(looseDraft(m, 'a', 'b'));
    expect(out.ok).toBe(false);
  });

  it('is a no-op on a row dropped already', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      dropProposal(ctx, row('a').id);
      dropProposal(ctx, row('a').id);
    });
    expect(row('a').state).toBe(ShapeProposalState.Rejected);
  });
});
