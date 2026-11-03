import {
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalState,
  type ShapeProposalDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { reconcileDraft } from './rounds';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §6 Editing and What changed, and why: the builder edits, restores and drops rows; the
// edit reaches the next turn as a note; and each row says what the latest round did to it.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
const round = (draft: Record<string, unknown>): void => {
  f.c.store.write((ctx) => reconcileDraft(ctx, shapeId(), PlanDraft.parse(draft)));
};
const task = (m: string, key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [m],
  ...extra,
});
const row = (key: string): ShapeProposalDto =>
  must(
    f.service.view(shapeId()).proposals.find((p) => p.key === key),
    `row ${key}`,
  );

describe('the marks a round leaves', () => {
  it('marks a created row new, a changed one changed, one left out moved, and the rest nothing', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b'), task(m, 'c')] });
    expect(['a', 'b', 'c'].map((k) => row(k).mark)).toEqual(['new', 'new', 'new']);

    round({ looseTasks: [task(m, 'a'), task(m, 'b', { size: 'M' })] });
    expect(['a', 'b', 'c'].map((k) => row(k).mark)).toEqual([null, 'changed', 'moved']);
    expect(row('c').state).toBe(ShapeProposalState.Superseded);
  });

  it('clears every mark when the next round leaves a row alone', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b')] });
    round({ looseTasks: [task(m, 'a', { size: 'M' })] });
    expect([row('a').mark, row('b').mark]).toEqual(['changed', 'moved']);
    round({ looseTasks: [task(m, 'a', { size: 'M' })] });
    expect([row('a').mark, row('b').mark]).toEqual([null, null]);
  });

  it('marks nothing for a change in the sources alone', () => {
    const m = f.c.say();
    const n = f.c.say('More.');
    round({ looseTasks: [task(m, 'a')] });
    round({ looseTasks: [task(n, 'a')] });
    expect(row('a').mark).toBeNull();
  });

  it('carries the messages a row came from, for Why?', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    expect(row('a').sourceMessageIds).toEqual([m]);
  });

  it('does not mark a row the builder restored from Earlier as changed', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b')] });
    round({ looseTasks: [task(m, 'a')] });
    f.service.restoreProposal(shapeId(), row('b').id);
    expect(row('b')).toMatchObject({ state: 'pending', mark: null, pinned: ['*'] });
  });
});

describe('editing a row', () => {
  it('pins the field, keeps it through the next round, and says so in the transcript', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    f.service.editProposal(shapeId(), row('a').id, { size: 'M' });
    expect(row('a')).toMatchObject({ pinned: ['size'], body: { size: 'M' } });

    round({ looseTasks: [task(m, 'a', { size: 'L' })] });
    expect(row('a').body).toMatchObject({ size: 'M' });

    const note = f.service.view(shapeId()).messages.find((x) => x.kind === ShapeMessageKind.Edit);
    expect(note).toMatchObject({ author: ShapeMessageAuthor.Note });
    expect(note?.body).toBe('The builder set Task a’s size to M');
  });

  it('announces the change to the screen', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    f.events.length = 0;
    f.service.editProposal(shapeId(), row('a').id, { title: 'Mine' });
    expect(
      f.events.filter((e) => e.type === EventType.ShapeChanged && e.entityId === shapeId()),
    ).not.toHaveLength(0);
  });

  it('refuses an edit that does not fit the row, writing neither the edit nor a note', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    expect(() => {
      f.service.editProposal(shapeId(), row('a').id, { size: 'huge' });
    }).toThrow(/does not fit/);
    expect(row('a').pinned).toEqual([]);
    expect(f.service.view(shapeId()).messages.some((x) => x.kind === ShapeMessageKind.Edit)).toBe(
      false,
    );
  });

  it('refuses a converted row', async () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    await f.service.convert(shapeId(), [row('a').id]);
    expect(() => {
      f.service.editProposal(shapeId(), row('a').id, { title: 'Late' });
    }).toThrow(ConflictError);
  });

  it('refuses a row of another conversation', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a')] });
    const other = f.service.create(f.c.project.id, { title: 'Other', origin: 'app' });
    expect(() => {
      f.service.editProposal(other.id, row('a').id, { title: 'Nope' });
    }).toThrow(NotFoundError);
    expect(() => {
      f.service.editProposal(shapeId(), mintId('ShapeProposal'), { title: 'Nope' });
    }).toThrow(NotFoundError);
  });
});

describe('the builder’s edits reach Claude’s next turn as notes', () => {
  async function nextPrompt(send: string): Promise<string> {
    let seen = '';
    f.adapter.shapeBehaviour = (turn) => {
      seen = turn.message;
      return Promise.resolve({ text: 'ok' });
    };
    f.service.send(shapeId(), send);
    await f.service.settled(shapeId());
    return seen;
  }

  it('puts every edit since the last turn before the message, once', async () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b')] });
    f.service.editProposal(shapeId(), row('a').id, { size: 'M' });
    f.service.dropProposal(shapeId(), row('b').id);
    const first = await nextPrompt('Thoughts?');
    expect(first).toContain('[note] The builder set Task a’s size to M');
    expect(first).toContain('[note] The builder dropped Task b; do not propose it again');
    expect(first.indexOf('[note]')).toBeLessThan(first.indexOf('Thoughts?'));
    const second = await nextPrompt('And now?');
    expect(second).not.toContain('[note]');
  });

  it('says what a restore and an unpin did', async () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b')] });
    round({ looseTasks: [task(m, 'a')] });
    f.service.restoreProposal(shapeId(), row('b').id);
    f.service.editProposal(shapeId(), row('a').id, { size: 'L' });
    f.service.unpinProposal(shapeId(), row('a').id, 'size');
    const prompt = await nextPrompt('Go on');
    expect(prompt).toContain('[note] The builder restored Task b and pinned it');
    expect(prompt).toContain('[note] The builder unpinned Task a’s size');
  });
});

describe('Drop', () => {
  it('tombstones the key: a later round naming it is refused', () => {
    const m = f.c.say();
    round({ looseTasks: [task(m, 'a'), task(m, 'b')] });
    f.service.dropProposal(shapeId(), row('b').id);
    expect(row('b').state).toBe(ShapeProposalState.Rejected);
    const out = f.c.store.write((ctx) =>
      reconcileDraft(ctx, shapeId(), PlanDraft.parse({ looseTasks: [task(m, 'a'), task(m, 'b')] })),
    ).value;
    expect(out.ok).toBe(false);
  });
});
