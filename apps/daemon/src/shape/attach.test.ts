import {
  mintId,
  PlanDraft,
  ShapeProposalState,
  ShapeToolInputs,
  type ShapeToolName,
} from '@10db/contracts';
import { listShapeMessages, listShapeProposals, patchShape, type WriteContext } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { looseDraft, seedConversation, type ConversationFixture } from './conversation-fixture';
import { convertProposals } from './convert';
import { reconcileDraft } from './rounds';
import { createShapeToolHandlers } from './tools';
import { buildShapeView } from './view';

// Shape spec §10.3: the session attaches a Mermaid diagram, a chart or an HTML mockup to a proposed
// task or goal, or to one it converted; the view carries each, for the sidebar to render inert.

let c: ConversationFixture;
let state: StateStore;
beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;

const call = (name: ShapeToolName, input: unknown): Promise<unknown> => {
  const handler = createShapeToolHandlers({ state }, c.shape.id)[name] as
    ((i: unknown) => Promise<unknown>) | undefined;
  if (!handler) throw new Error(`no ${name}`);
  return handler(ShapeToolInputs[name].parse(input));
};

function propose(...keys: string[]): void {
  const out = write((ctx) =>
    reconcileDraft(ctx, c.shape.id, PlanDraft.parse(looseDraft(c.say(), ...keys))),
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
}

const view = () =>
  buildShapeView(c.store.db, c.shape.id, {
    running: false,
    queued: 0,
    proposing: false,
    rehearsing: false,
    waitingForUpdate: false,
  });

const diagram = { kind: 'mermaid', source: 'flowchart LR\n  a --> b' } as const;

describe('attach', () => {
  it('keeps a diagram on a proposed task, and the view carries it', async () => {
    propose('density');
    await expect(
      call('attach', { target: { key: 'density' }, attachment: diagram }),
    ).resolves.toEqual({
      attached: true,
    });
    expect(view().attachments).toEqual([
      expect.objectContaining({ key: 'density', goalId: null, taskId: null, attachment: diagram }),
    ]);
    expect(listShapeMessages(c.store.db, c.shape.id).at(-1)?.body).toBe(
      'attach · mermaid · density',
    );
  });

  it('keeps every attachment of a row, a chart and a mockup beside the diagram', async () => {
    propose('density');
    const chart = { kind: 'chart', spec: { mark: 'bar', data: { values: [{ a: 1 }] } } } as const;
    const mockup = { kind: 'mockup', html: '<p>Cards</p>' } as const;
    for (const attachment of [diagram, chart, mockup])
      await call('attach', { target: { key: 'density' }, attachment });
    expect(view().attachments.map((a) => a.attachment.kind)).toEqual([
      'mermaid',
      'chart',
      'mockup',
    ]);
  });

  it('refuses a key that is not in the plan, naming it', async () => {
    propose('density');
    await expect(call('attach', { target: { key: 'nope' }, attachment: diagram })).rejects.toThrow(
      /no task or goal with the key nope/,
    );
  });

  it('attaches to a task this conversation converted, and refuses one it did not', async () => {
    propose('density');
    const out = write((ctx) =>
      convertProposals(
        ctx,
        c.shape.id,
        listShapeProposals(ctx.tx, c.shape.id)
          .filter((r) => r.state === ShapeProposalState.Pending)
          .map((r) => r.id),
      ),
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    const taskId = out.results.flatMap((r) => r.taskIds)[0];
    if (taskId === undefined) throw new Error('no task');
    await call('attach', { target: { taskId }, attachment: diagram });
    expect(view().attachments.at(-1)).toEqual(
      expect.objectContaining({ taskId, goalId: null, attachment: diagram }),
    );
    await expect(
      call('attach', { target: { taskId: mintId('Task') }, attachment: diagram }),
    ).rejects.toThrow(/did not come from this conversation/);
  });

  it('leaves specs and evals out of the view’s attachments', async () => {
    write((ctx) => {
      patchShape(ctx, c.shape.id, { proposeUnlocked: true });
    });
    propose('density');
    await call('write_spec', { effortKey: 'density', markdown: '# Spec' });
    expect(view().attachments).toEqual([]);
  });
});
