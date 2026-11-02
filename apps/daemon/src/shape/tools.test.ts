import {
  InvalidError,
  ShapeMessageKind,
  ShapeProposalState,
  ShapeState,
  ShapeToolInputs,
  type ShapeMessageDto,
} from '@10db/contracts';
import { getShape, listShapeMessages, listShapeProposals, patchShape } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { looseDraft, seedConversation, type ConversationFixture } from './conversation-fixture';
import { createShapeToolHandlers } from './tools';

// Shape spec §5.5, §6: note_heard and propose_plan, which is refused until the first Propose.

let c: ConversationFixture;
let state: StateStore;
let proposals: boolean[];
beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
  proposals = [];
});
afterEach(() => {
  c.close();
});

const tools = () =>
  createShapeToolHandlers(
    {
      state,
      onProposal: (_shapeId, accepted) => {
        proposals.push(accepted);
      },
    },
    c.shape.id,
  );
const propose = (draft: unknown) => {
  const handler = tools().propose_plan;
  if (!handler) throw new Error('no propose_plan');
  // The MCP endpoint parses a call's input with the tool's schema before the handler sees it.
  return handler(ShapeToolInputs.propose_plan.parse({ draft }));
};
const unlock = (): void => {
  state.write((ctx) => {
    patchShape(ctx, c.shape.id, { proposeUnlocked: true });
  });
};
const transcript = (): ShapeMessageDto[] =>
  listShapeMessages(c.store.db, c.shape.id).filter((m) => m.kind === ShapeMessageKind.Tool);

describe('propose_plan before the first Propose', () => {
  it('is refused, writes no row, and says why', async () => {
    const m = c.say();
    await expect(propose(looseDraft(m, 'a'))).rejects.toThrow(/until the builder presses Propose/);
    expect(listShapeProposals(c.store.db, c.shape.id)).toEqual([]);
    expect(getShape(c.store.db, c.shape.id).state).toBe(ShapeState.Listening);
    expect(proposals).toEqual([false]);
    expect(transcript().map((t) => t.body)).toEqual(['propose_plan · refused']);
  });
});

describe('propose_plan after Propose', () => {
  it('turns a valid draft into shape_proposals rows', async () => {
    unlock();
    const m = c.say();
    const result = await propose(looseDraft(m, 'a', 'b'));
    expect(result).toMatchObject({ round: 1, created: ['a', 'b'] });
    expect(listShapeProposals(c.store.db, c.shape.id).map((r) => [r.key, r.state])).toEqual([
      ['a', ShapeProposalState.Pending],
      ['b', ShapeProposalState.Pending],
    ]);
    expect(proposals).toEqual([true]);
    expect(transcript().map((t) => t.body)).toEqual(['propose_plan · 2 loose · passed']);
  });

  it('returns every error of an invalid draft at once, and writes no row', async () => {
    unlock();
    const m = c.say();
    const draft = {
      looseTasks: [
        { ...(looseDraft(m, 'a') as { looseTasks: object[] }).looseTasks[0], areas: ['nowhere'] },
        { ...(looseDraft(m, 'b') as { looseTasks: object[] }).looseTasks[0], dependsOn: ['typo'] },
      ],
    };
    const error = await propose(draft).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidError);
    const text = error instanceof Error ? error.message : '';
    expect(text).toContain('2 errors');
    expect(text).toContain('Loose task 1, areas: the project has no area nowhere');
    expect(text).toContain('Loose task 2, depends on: no proposal has the key typo');
    expect(listShapeProposals(c.store.db, c.shape.id)).toEqual([]);
    expect(proposals).toEqual([false]);
    expect(transcript().map((t) => t.body)).toEqual(['propose_plan · refused · 2 errors']);
  });
});

describe('note_heard', () => {
  it('records the echo in the transcript and proposes nothing', async () => {
    const result = await tools().note_heard?.({ items: ['Density first', 'Thin scrollbars'] });
    expect(result).toEqual({ heard: 2 });
    expect(transcript().map((t) => t.body)).toEqual([
      'note_heard · Density first · Thin scrollbars',
    ]);
    expect(listShapeProposals(c.store.db, c.shape.id)).toEqual([]);
  });
});

describe('the tool set', () => {
  it('offers note_heard and propose_plan in this slice', () => {
    expect(Object.keys(tools()).sort()).toEqual(['note_heard', 'propose_plan']);
  });
});
