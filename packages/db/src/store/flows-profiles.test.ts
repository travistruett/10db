import { ConflictError, EventType, InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAaModels, replaceAaModels } from './aa-models';
import { findFlowByName, insertFlow, listFlows, patchFlow } from './flows';
import {
  applyAaMeasurement,
  findModelProfile,
  insertModelProfile,
  listModelProfiles,
  patchModelProfile,
  recordProfileOutcome,
} from './model-profiles';
import type { Store } from './store';
import { insertPersona } from './team';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('flows', () => {
  it('inserts with defaults filled, finds by name, patches the steps and refuses a duplicate name', () => {
    const { value: flow, events } = store.write((ctx) =>
      insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.FlowSaved]);
    expect(flow.steps).toEqual([{ role: 'implement', need: 40, skip: [], persona: null }]);
    expect(findFlowByName(store.db, 'quick')).toEqual(flow);
    store.write((ctx) =>
      patchFlow(ctx, flow.id, {
        steps: [
          { role: 'implement', need: 42 },
          { role: 'review', need: 48 },
        ],
      }),
    );
    expect(listFlows(store.db)[0]?.steps.map((s) => s.role)).toEqual(['implement', 'review']);
    expect(() =>
      store.write((ctx) =>
        insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 1 }] }),
      ),
    ).toThrow(ConflictError);
  });

  it.each([
    { name: 'a persona that does not exist', persona: 'ghost' },
    { name: 'a persona that plays another role', persona: 'implementer' },
  ])('refuses a step naming $name', ({ persona }) => {
    store.write((ctx) =>
      insertPersona(ctx, {
        key: 'implementer',
        name: 'Implementer',
        role: 'implement',
        tools: 'edit',
        instructions: 'Build it.',
      }),
    );
    expect(() =>
      store.write((ctx) =>
        insertFlow(ctx, {
          name: 'two-reviews',
          steps: [
            { role: 'implement', need: 40 },
            { role: 'review', need: 48, persona },
          ],
        }),
      ),
    ).toThrow(InvalidError);
  });
});

describe('model profiles', () => {
  const definition = {
    provider: 'claude',
    model: 'sonnet',
    effort: 'high',
    aaSlug: 'test-family-high',
    enabled: true,
  } as const;
  const measurement = {
    scores: { intelligence: 50, coding: 45, agentic: 40 },
    costPerTaskUsd: 1.5,
    outputTokensPerSecond: 80,
    indexVersion: '9.9',
    measuredAt: '2026-10-17T12:00:00.000Z',
  };

  it('starts unmeasured from AA, takes a measurement, and counts outcomes', () => {
    const profile = store.write((ctx) => insertModelProfile(ctx, definition)).value;
    expect(profile).toMatchObject({
      source: 'aa',
      scores: { intelligence: null, coding: null, agentic: null },
      costPerTaskUsd: null,
    });
    expect(findModelProfile(store.db, 'claude', 'sonnet', 'high')).toEqual(profile);
    expect(() => store.write((ctx) => insertModelProfile(ctx, definition))).toThrow(ConflictError);
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(true);
    store.write((ctx) => {
      recordProfileOutcome(ctx, profile.id, { firstPass: true, escalated: false });
      recordProfileOutcome(ctx, profile.id, { firstPass: false, escalated: true });
    });
    expect(listModelProfiles(store.db)[0]).toMatchObject({
      ...measurement,
      stepsRun: 2,
      firstPassSteps: 1,
      escalations: 1,
    });
  });

  it('makes a hand-edited profile manual, ignores the sync, and hands back on request', () => {
    const profile = store.write((ctx) => insertModelProfile(ctx, definition)).value;
    const { events } = store.write((ctx) =>
      patchModelProfile(ctx, profile.id, { costPerTaskUsd: 2 }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.ModelProfileSaved]);
    expect(listModelProfiles(store.db)[0]).toMatchObject({ source: 'manual', costPerTaskUsd: 2 });
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(
      false,
    );
    store.write((ctx) => patchModelProfile(ctx, profile.id, { source: 'aa' }));
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(true);
  });
});

describe('AA models', () => {
  const model = (slug: string, intelligence: number) => ({
    slug,
    name: slug,
    creator: 'Test Lab',
    releaseDate: null,
    indexVersion: '9.9',
    evaluations: { artificial_analysis_intelligence_index: intelligence },
    costPerTaskUsd: 0.5,
    pricing: {},
    performance: {},
    fetchedAt: '2026-10-17T12:00:00.000Z',
  });

  it('replaces the whole list, dropping models AA no longer lists, with one event', () => {
    store.write((ctx) => {
      replaceAaModels(ctx, [model('a', 10), model('b', 20)]);
    });
    const { events } = store.write((ctx) => {
      replaceAaModels(ctx, [model('b', 21), model('c', 30)]);
    });
    expect(events.map((e) => e.type)).toEqual([EventType.BenchmarksSynced]);
    expect(
      listAaModels(store.db).map((m) => [
        m.slug,
        m.evaluations['artificial_analysis_intelligence_index'],
      ]),
    ).toEqual([
      ['b', 21],
      ['c', 30],
    ]);
  });
});
