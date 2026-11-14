import { ConflictError, EventType } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAaModels, replaceAaModels } from './aa-models';
import {
  applyAaMeasurement,
  findModelProfile,
  insertModelProfile,
  listModelProfiles,
  patchModelProfile,
  recordProfileOutcome,
  upsertModelProfiles,
} from './model-profiles';
import type { Store } from './store';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
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
    scores: { intelligence: 50 },
    costPerTaskUsd: 1.5,
    outputTokensPerSecond: 80,
    indexVersion: '9.9',
    measuredAt: '2026-10-17T12:00:00.000Z',
  };

  it('starts unmeasured from AA, takes a measurement, and counts outcomes', () => {
    const profile = store.write((ctx) => insertModelProfile(ctx, definition)).value;
    expect(profile).toMatchObject({
      source: 'aa',
      scores: { intelligence: null },
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

  const catalogued = {
    ...definition,
    maker: 'Anthropic',
    family: 'claude-sonnet',
    tier: 'balanced',
    status: 'current',
    inputPrice: 3,
    outputPrice: 15,
    releaseDate: '2026-09-01',
  } as const;

  it('upserts catalogue fields and the enabled flag, leaving scores and the id as they were', () => {
    const { events } = store.write((ctx) => {
      upsertModelProfiles(ctx, [catalogued]);
    });
    expect(events.map((e) => e.type)).toEqual([EventType.ModelProfileSaved]);
    const first = findModelProfile(store.db, 'claude', 'sonnet', 'high');
    if (!first) throw new Error('the profile was not stored');
    expect(listModelProfiles(store.db)).toHaveLength(1);
    expect(first).toMatchObject({
      maker: 'Anthropic',
      tier: 'balanced',
      releaseDate: '2026-09-01',
    });

    store.write((ctx) => applyAaMeasurement(ctx, first.id, measurement));
    store.write((ctx) => {
      upsertModelProfiles(ctx, [
        { ...catalogued, status: 'superseded', inputPrice: 2, enabled: false },
      ]);
    });
    const second = listModelProfiles(store.db);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      id: first.id,
      status: 'superseded',
      inputPrice: 2,
      enabled: false,
      scores: { intelligence: 50 },
    });
  });

  it('writes nothing when the catalogue fields are unchanged', () => {
    store.write((ctx) => {
      upsertModelProfiles(ctx, [catalogued]);
    });
    const { events } = store.write((ctx) => {
      upsertModelProfiles(ctx, [catalogued]);
    });
    expect(events).toEqual([]);
  });

  it('writes a change to the enabled flag alone', () => {
    store.write((ctx) => {
      upsertModelProfiles(ctx, [catalogued]);
    });
    const { events } = store.write((ctx) => {
      upsertModelProfiles(ctx, [{ ...catalogued, enabled: false }]);
    });
    expect(events.map((e) => e.type)).toEqual([EventType.ModelProfileSaved]);
    expect(findModelProfile(store.db, 'claude', 'sonnet', 'high')?.enabled).toBe(false);
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
