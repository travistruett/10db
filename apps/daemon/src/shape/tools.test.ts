import {
  InvalidError,
  ShapeMessageKind,
  ShapeProposalState,
  ShapeState,
  ShapeToolInputs,
  type ShapeMessageDto,
} from '@10db/contracts';
import {
  findDocument,
  getShape,
  listAttachmentRevisions,
  listShapeFindings,
  listShapeMessages,
  listShapeProposals,
  patchShape,
} from '@10db/db';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { importBundle, loadStoredRecord, planImportChanges } from '../plan-record';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { looseDraft, seedConversation, type ConversationFixture } from './conversation-fixture';
import { ToolImages } from '../mcp';
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
  it('offers every Shape tool: the planning tools, attach and the review tools', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'attach',
      'find_records',
      'note_heard',
      'propose_plan',
      'report_finding',
      'resolve_finding',
      'similar_tasks',
      'write_spec',
    ]);
  });

  it('offers see_screen only when 10db can draw a screen', async () => {
    expect(tools().see_screen).toBeUndefined();
    const seen: unknown[] = [];
    const picture = new ToolImages('The Board', []);
    const handlers = createShapeToolHandlers(
      {
        state,
        screens: {
          see: (shapeId, input) => {
            seen.push([shapeId, input]);
            return Promise.resolve(picture);
          },
        },
      },
      c.shape.id,
    );
    const handler = handlers.see_screen;
    if (!handler) throw new Error('no see_screen');
    const input = ShapeToolInputs.see_screen.parse({ screen: 'board', width: 900 });
    expect(await handler(input)).toBe(picture);
    expect(seen).toEqual([[c.shape.id, { screen: 'board', width: 900, height: 900 }]]);
  });

  it('answers similar_tasks with nothing when no finished task is alike, and says so', async () => {
    const handler = tools().similar_tasks;
    if (!handler) throw new Error('no similar_tasks');
    expect(await handler(ShapeToolInputs.similar_tasks.parse({ query: 'board' }))).toEqual({
      tasks: [],
    });
    expect(transcript().map((m) => m.body)).toEqual(['similar_tasks · 0 tasks']);
  });
});

describe('an imported Plan', () => {
  /** Imports the fixture bundle into the conversation's project and answers its Plan's handlers. */
  function imported() {
    const bundle = parseBundle(bundleJson(c.project.id));
    const bodies = inlineBodies(bundle);
    const { shapeId } = state.write((ctx) =>
      importBundle(ctx, {
        projectId: c.project.id,
        bundle,
        bodies,
        changes: planImportChanges(
          loadStoredRecord(ctx.tx, c.project.id, bundle.id),
          bundle,
          bodies,
        ),
      }),
    );
    state.write((ctx) => {
      patchShape(ctx, shapeId, { proposeUnlocked: true });
    });
    const handlers = createShapeToolHandlers(
      {
        state,
        onProposal: (_shapeId, accepted) => {
          proposals.push(accepted);
        },
      },
      shapeId,
    );
    const lines = () =>
      listShapeMessages(c.store.db, shapeId)
        .filter((m) => m.kind === ShapeMessageKind.Tool)
        .map((m) => m.body);
    return { shapeId, handlers, lines };
  }
  const REFUSAL = /This Plan was imported\. Re-import to change it\./;

  it('propose_plan on an imported Plan is refused and changes nothing', async () => {
    const { shapeId, handlers, lines } = imported();
    const before = listShapeProposals(c.store.db, shapeId);
    const propose = handlers.propose_plan;
    if (!propose) throw new Error('no propose_plan');
    const m = c.say();
    await expect(
      propose(ShapeToolInputs.propose_plan.parse({ draft: looseDraft(m, 'a') })),
    ).rejects.toThrow(REFUSAL);
    expect(listShapeProposals(c.store.db, shapeId)).toEqual(before);
    expect(proposals).toEqual([false]);
    expect(lines()).toEqual(['propose_plan · refused']);
  });

  it('write_spec on an imported Plan is refused and adds no revision', async () => {
    const { shapeId, handlers, lines } = imported();
    const spec = findDocument(c.store.db, shapeId, 's1');
    const before = spec ? listAttachmentRevisions(c.store.db, spec.id) : [];
    const writeSpec = handlers.write_spec;
    if (!writeSpec) throw new Error('no write_spec');
    await expect(
      writeSpec(ShapeToolInputs.write_spec.parse({ effortKey: 'g1', markdown: '# Model-written' })),
    ).rejects.toThrow(REFUSAL);
    expect(spec && listAttachmentRevisions(c.store.db, spec.id)).toEqual(before);
    expect(lines()).toEqual(['write_spec · refused']);
  });

  it('resolve_finding on an imported finding is refused and leaves its state and how', async () => {
    const { shapeId, handlers } = imported();
    const [finding] = listShapeFindings(c.store.db, shapeId);
    if (!finding) throw new Error('no imported finding');
    const resolve = handlers.resolve_finding;
    if (!resolve) throw new Error('no resolve_finding');
    await expect(
      resolve(ShapeToolInputs.resolve_finding.parse({ findingId: finding.id, how: 'Rewrote it' })),
    ).rejects.toThrow(REFUSAL);
    expect(listShapeFindings(c.store.db, shapeId)[0]).toMatchObject({
      state: finding.state,
      how: finding.how,
    });
  });

  it('report_finding on an imported Plan still adds a finding', async () => {
    const { shapeId, handlers } = imported();
    const report = handlers.report_finding;
    if (!report) throw new Error('no report_finding');
    await report(
      ShapeToolInputs.report_finding.parse({
        effortKey: 'g1',
        reviewer: 'scope',
        finding: { kind: 'finding', severity: 'low', text: 'Name the port' },
      }),
    );
    expect(listShapeFindings(c.store.db, shapeId).map((f) => [f.reviewer, f.text])).toEqual([
      ['imported', 'Revoked devices keep their session'],
      ['scope', 'Name the port'],
    ]);
  });
});
