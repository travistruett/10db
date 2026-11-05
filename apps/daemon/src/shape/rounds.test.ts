import { PlanDraft, ShapeProposalState, ShapeState } from '@10db/contracts';
import { getShape, listShapeProposals, type WriteContext } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looseDraft, seedConversation, type ConversationFixture } from './conversation-fixture';
import {
  dropProposal,
  editProposal,
  reconcileDraft,
  restoreProposal,
  type ProposeOutcome,
} from './rounds';

// Shape spec §6 Rounds: create, update, supersede, a pin kept, restore, a dropped key reused, a
// change re-proposed after a drop.

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
const rows = () => listShapeProposals(c.store.db, c.shape.id);
const row = (key: string) => {
  const found = rows().find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};
const stateOf = (key: string) => row(key).state;

describe('a round', () => {
  it('creates a row per key and moves the conversation to proposed', () => {
    const m = c.say();
    const out = propose(looseDraft(m, 'a', 'b'));
    expect(out).toMatchObject({ ok: true, round: 1, created: ['a', 'b'] });
    expect(rows().map((r) => [r.key, r.kind, r.state, r.round])).toEqual([
      ['a', 'task', 'pending', 1],
      ['b', 'task', 'pending', 1],
    ]);
    expect(row('a').sourceMessageIds).toEqual([m]);
    expect(getShape(c.store.db, c.shape.id)).toMatchObject({
      round: 1,
      state: ShapeState.Proposed,
    });
  });

  it('updates a key the draft states again, and marks the fields that changed', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    const first = row('a').taskHashes['a'];
    const next = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
    next.looseTasks[0] = { ...next.looseTasks[0], title: 'A better title' };
    expect(propose(next)).toMatchObject({ ok: true, round: 2, updated: ['a'] });
    const after = row('a').taskHashes['a'];
    expect(after?.hash).not.toBe(first?.hash);
    expect(after?.changedFields).toEqual(['title']);
    expect(row('a').round).toBe(2);
  });

  it('refuses a key stated under another kind than its stored row, and writes nothing', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    const before = rows();
    const asGoal = {
      goals: [
        {
          key: 'a',
          title: 'Goal',
          objective: 'Do it.',
          ceremony: 'direct',
          sourceMessageIds: [m],
          tasks: [{ key: 'a1', title: 'Only task', areas: ['api'], size: 'S' }],
        },
      ],
    };
    expect(propose(asGoal)).toEqual({
      ok: false,
      errors: ['a: stored as a task, so it cannot be stated as a goal; use another key'],
    });
    expect(rows()).toEqual(before);
    expect(getShape(c.store.db, c.shape.id).round).toBe(1);
  });

  it('marks nothing for a row the draft restates unchanged', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    propose(looseDraft(m, 'a'));
    expect(row('a').taskHashes['a']?.changedFields).toEqual([]);
  });

  it('supersedes a pending key the draft leaves out', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    expect(propose(looseDraft(m, 'a'))).toMatchObject({ ok: true, superseded: ['b'] });
    expect(stateOf('b')).toBe(ShapeProposalState.Superseded);
    expect(stateOf('a')).toBe(ShapeProposalState.Pending);
  });

  it('brings a superseded key back when a later draft states it again', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    propose(looseDraft(m, 'a'));
    propose(looseDraft(m, 'a', 'b'));
    expect(stateOf('b')).toBe(ShapeProposalState.Pending);
  });

  it('keeps a pinned field over the draft, and a row with a pin when the draft leaves it out', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    write((ctx) => {
      editProposal(ctx, row('a').id, { title: 'Pinned title' });
      editProposal(ctx, row('b').id, { title: 'Pinned too' });
    });
    const next = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
    next.looseTasks[0] = { ...next.looseTasks[0], title: 'Claude’s title', size: 'M' };
    expect(propose(next)).toMatchObject({ ok: true, kept: ['b'], superseded: [] });
    expect(row('a').body).toMatchObject({ title: 'Pinned title', size: 'M' });
    expect(stateOf('b')).toBe(ShapeProposalState.Pending);
  });

  it('keeps the pin whichever of an edit and a reconcile lands second', () => {
    const m = c.say();
    propose(looseDraft(m, 'a'));
    // A reconcile, then an edit: the edit overwrites.
    const next = looseDraft(m, 'a') as { looseTasks: Record<string, unknown>[] };
    next.looseTasks[0] = { ...next.looseTasks[0], title: 'Claude’s' };
    propose(next);
    write((ctx) => {
      editProposal(ctx, row('a').id, { title: 'Builder’s' });
    });
    expect(row('a').body).toMatchObject({ title: 'Builder’s' });
    // An edit, then a reconcile: the pin holds.
    next.looseTasks[0] = { ...next.looseTasks[0], title: 'Claude’s again' };
    propose(next);
    expect(row('a').body).toMatchObject({ title: 'Builder’s' });
  });

  it('holds a restored row as a whole', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    propose(looseDraft(m, 'a'));
    write((ctx) => {
      restoreProposal(ctx, row('b').id);
    });
    expect(stateOf('b')).toBe(ShapeProposalState.Pending);
    expect(propose(looseDraft(m, 'a'))).toMatchObject({ ok: true, kept: ['b'] });
    expect(stateOf('b')).toBe(ShapeProposalState.Pending);
  });

  it('refuses a draft that reuses a dropped key, writing nothing', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    write((ctx) => {
      dropProposal(ctx, row('b').id);
    });
    const out = propose(looseDraft(m, 'a', 'b', 'c'));
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? [] : out.errors.join('\n')).toMatch(/b: the builder dropped this row/);
    expect(rows().map((r) => r.key)).toEqual(['a', 'b']);
    expect(getShape(c.store.db, c.shape.id).round).toBe(1);
  });

  it('tells a dropped key restated under another kind it was dropped, not to use another key', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    write((ctx) => {
      dropProposal(ctx, row('b').id);
    });
    const before = rows();
    const out = propose({
      goals: [
        {
          key: 'b',
          title: 'Goal',
          objective: 'Do it.',
          ceremony: 'direct',
          sourceMessageIds: [m],
          tasks: [{ key: 'b1', title: 'Only task', areas: ['api'], size: 'S' }],
        },
      ],
    });
    expect(out.ok ? [] : out.errors).toEqual([
      'b: the builder dropped this row; do not propose it again. Raise it in chat as a question if it matters.',
    ]);
    expect(rows()).toEqual(before);
  });

  it('refuses a dropped loose task restated as a task inside a goal, writing nothing', () => {
    const m = c.say();
    propose(looseDraft(m, 'a', 'b'));
    write((ctx) => {
      dropProposal(ctx, row('b').id);
    });
    const before = rows();
    const out = propose({
      goals: [
        {
          key: 'g',
          title: 'Goal',
          objective: 'Do it.',
          ceremony: 'direct',
          sourceMessageIds: [m],
          tasks: [{ key: 'b', title: 'Dropped work, back', areas: ['api'], size: 'S' }],
        },
      ],
    });
    expect(out.ok ? [] : out.errors).toEqual([
      'b: the builder dropped this row; do not propose it again. Raise it in chat as a question if it matters.',
    ]);
    expect(rows()).toEqual(before);
    expect(getShape(c.store.db, c.shape.id).round).toBe(1);
  });

  it('writes nothing for an invalid draft, and says every error', () => {
    const m = c.say();
    const out = propose({
      looseTasks: [
        { ...(looseDraft(m, 'a') as { looseTasks: object[] }).looseTasks[0], areas: ['nowhere'] },
        { ...(looseDraft(m, 'b') as { looseTasks: object[] }).looseTasks[0], dependsOn: ['typo'] },
      ],
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? [] : out.errors).toHaveLength(2);
    expect(rows()).toEqual([]);
    expect(getShape(c.store.db, c.shape.id)).toMatchObject({
      round: 0,
      state: ShapeState.Listening,
    });
  });

  it('does not let a draft cite a message from another conversation', () => {
    const other = seedConversation();
    const foreign = other.say();
    other.close();
    const out = propose(looseDraft(foreign, 'a'));
    expect(out.ok).toBe(false);
  });
});
