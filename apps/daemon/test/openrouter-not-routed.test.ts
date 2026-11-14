import { createTestStore, applyAaMeasurement, listModelProfiles } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatalogue } from '../src/catalogue';
import { createOpenRouterSync } from '../src/benchmarks';
import { ManualClock } from '../src/clock';
import { createEventBus, createStateStore, type StateStore } from '../src/events';
import { silentLogger } from '../src/log';
import { chooseModel } from '../src/routing';
import { readModelsDevFixture } from './models-dev-fixture';
import { seedProfiles } from './seed-profiles';

const BENCHMARKS = 'https://openrouter.ai/api/v1/benchmarks';
const A = 'claude-opus-5-5';
const B = 'claude-haiku-5-5';

let state: StateStore;
let close: () => void;
let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedProfiles(state);
});
afterEach(() => {
  close();
});

/** What OpenRouter answers: scores and speeds that would reverse the order Artificial Analysis gave. */
function openRouter(url: string): Response {
  if (url === `${BENCHMARKS}?source=artificial-analysis`)
    return Response.json({
      data: [
        { model_permaslug: 'anthropic/claude-opus-5.5-20261109', intelligence_index: 10 },
        { model_permaslug: 'anthropic/claude-haiku-5.5-20261109', intelligence_index: 95 },
      ],
    });
  if (url === `${BENCHMARKS}?source=openrouter`)
    return Response.json({
      data: [{ model_permaslug: 'liquid/d1', benchmark_type: 'gpqa', accuracy: 0.5 }],
    });
  if (url === 'https://openrouter.ai/api/v1/models')
    return Response.json({
      data: [{ id: 'anthropic/claude-opus-5.5' }, { id: 'anthropic/claude-haiku-5.5' }],
    });
  return Response.json({
    data: {
      endpoints: [
        {
          provider_name: 'Anthropic',
          throughput_last_30m: { p50: url.includes('haiku') ? 500 : 5 },
          latency_last_30m: { p50: 100 },
        },
      ],
    },
  });
}

describe('routing ignores what OpenRouter measures', () => {
  it('leaves every profile as it was and keeps the pick Artificial Analysis gave', async () => {
    // AA: the Opus profile is stronger and cheaper than the Haiku one, so it is the pick.
    state.write((ctx) => {
      for (const p of listModelProfiles(ctx.tx).filter((x) => x.effort === 'high')) {
        const aa = { indexVersion: '1.0', measuredAt: ctx.now };
        if (p.model === A)
          applyAaMeasurement(ctx, p.id, {
            scores: { intelligence: 80 },
            costPerTaskUsd: 0.5,
            outputTokensPerSecond: 40,
            ...aa,
          });
        if (p.model === B)
          applyAaMeasurement(ctx, p.id, {
            scores: { intelligence: 45 },
            costPerTaskUsd: 0.9,
            outputTokensPerSecond: 60,
            ...aa,
          });
      }
    });
    const before = listModelProfiles(state.db);
    const pick = () =>
      chooseModel({
        def: { role: 'implement', need: 40 },
        requirements: [{ kind: 'automatic' }],
        effort: null,
        fallback: null,
        pinned: false,
        task: { modelSetting: null, effortPin: null },
        project: { budgetCeiling: null },
        profiles: listModelProfiles(state.db).filter(
          (p) => p.effort === 'high' && (p.model === A || p.model === B),
        ),
        tierOverrides: {},
      }).model;
    expect(pick()).toBe(A);

    const sync = createOpenRouterSync({
      state,
      clock,
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(openRouter(url));
      },
      readKey: () => Promise.resolve('sk-or-test'),
      offered: () => new Set([A, B]),
      catalogue: () => parseCatalogue(readModelsDevFixture()),
      decisionModelIds: () => Promise.resolve([]),
      logger: silentLogger,
    });
    await sync.poke();
    expect(sync.status().outcome).toBe('ok');

    expect(listModelProfiles(state.db)).toEqual(before);
    expect(pick()).toBe(A);
  });
});
