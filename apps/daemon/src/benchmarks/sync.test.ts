import {
  createTestStore,
  findModelProfile,
  listAaModels,
  patchModelProfile,
  setAppSetting,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { seedTeam } from '../team';
import { AA_FREE_MODELS_URL, AA_MAX_PAGES } from './aa-client';
import { AA_SYNC_INTERVAL_MS, createBenchmarkSync } from './index';
import type { BenchmarkSyncDeps } from './sync';

const KEY = 'aa-test-key-123';

const entry = (slug: string, score: number) => ({
  id: `id-${slug}`,
  name: slug,
  slug,
  release_date: null,
  model_creator: { id: 'c', name: 'Test Lab' },
  evaluations: {
    artificial_analysis_intelligence_index: score,
    artificial_analysis_coding_index: score - 1,
    artificial_analysis_agentic_index: score - 2,
  },
  artificial_analysis_intelligence_index_cost: {
    total_cost: 1,
    cost_per_task: { total_cost: score / 100 },
  },
  pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
  performance: { median_output_tokens_per_second: 50 },
});
const page = (data: object[], hasMore: boolean, pageNo = 1, version = '9.9') => ({
  tier: 'free',
  intelligence_index_version: version,
  pagination: { page: pageNo, page_size: 200, total_pages: 2, has_more: hasMore },
  data,
});

let state: StateStore;
let close: () => void;
let clock: ManualClock;
let requests: { url: string; key: string | null }[];
beforeEach(() => {
  clock = new ManualClock(new Date('2026-10-17T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  requests = [];
});
afterEach(() => {
  close();
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error';
function fakeFetch(...replies: Reply[]): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      key: headers.get('x-api-key'),
    });
    const reply = replies.shift() ?? { status: 500 };
    if (reply === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        ...(reply.headers ? { headers: reply.headers } : {}),
      }),
    );
  };
}
const sync = (
  fetchImpl: BenchmarkSyncDeps['fetch'],
  key: string | null = KEY,
  store: StateStore = state,
) =>
  createBenchmarkSync({
    state: store,
    clock,
    fetch: fetchImpl,
    readKey: () => key,
    logger: silentLogger,
  });
const opusHigh = () => findModelProfile(state.db, 'claude', 'opus', 'high');

describe('benchmark sync', () => {
  it('stores every page and measures the profiles whose slug AA lists', async () => {
    const status = await sync(
      fakeFetch(
        {
          status: 200,
          body: page([entry('claude-opus-5-5-high', 50), entry('other-lab-model', 30)], true),
        },
        { status: 200, body: page([entry('claude-sonnet-5-5', 45)], false, 2) },
      ),
    ).sync();
    expect(requests).toEqual([
      { url: `${AA_FREE_MODELS_URL}?page=1`, key: KEY },
      { url: `${AA_FREE_MODELS_URL}?page=2`, key: KEY },
    ]);
    expect(listAaModels(state.db).map((m) => m.slug)).toEqual([
      'claude-opus-5-5-high',
      'claude-sonnet-5-5',
      'other-lab-model',
    ]);
    expect(opusHigh()).toMatchObject({
      scores: { intelligence: 50, coding: 49, agentic: 48 },
      costPerTaskUsd: 0.5,
      outputTokensPerSecond: 50,
      indexVersion: '9.9',
    });
    expect(status).toMatchObject({ outcome: 'ok', models: 3, keyConfigured: true });
    expect(status.unmeasuredProfiles).toContain('opus@medium');
    expect(status.unmeasuredProfiles).not.toContain('opus@high');
    expect(status.unmeasuredProfiles).not.toContain('fable@max'); // disabled profiles are not reported
  });

  it.each([
    { name: 'no key', key: null, replies: [], outcome: 'no_key', requests: 0 },
    {
      name: 'a rejected key',
      key: KEY,
      replies: [{ status: 401 }],
      outcome: 'unauthorized',
      requests: 1,
    },
    {
      name: 'the rate limit',
      key: KEY,
      replies: [{ status: 429, headers: { 'Retry-After': '3600' } }],
      outcome: 'rate_limited',
      requests: 1,
    },
    {
      name: 'a server error',
      key: KEY,
      replies: [{ status: 503 }],
      outcome: 'failed',
      requests: 1,
    },
    {
      name: 'a network error',
      key: KEY,
      replies: ['network-error' as const],
      outcome: 'failed',
      requests: 1,
    },
    {
      name: 'a response of the wrong shape',
      key: KEY,
      replies: [{ status: 200, body: { data: 'nope' } }],
      outcome: 'failed',
      requests: 1,
    },
    {
      name: 'an empty list',
      key: KEY,
      replies: [{ status: 200, body: page([], false) }],
      outcome: 'failed',
      requests: 1,
    },
  ])('keeps the last good data after $name', async ({ key, replies, outcome, requests: count }) => {
    await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    requests = [];
    const status = await sync(fakeFetch(...replies), key).sync();
    expect(status.outcome).toBe(outcome);
    expect(requests).toHaveLength(count);
    expect(listAaModels(state.db).map((m) => m.slug)).toEqual(['claude-opus-5-5-high']);
    expect(opusHigh()?.scores.intelligence).toBe(50);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('fails, keeping the last data, when the list runs past the page cap', async () => {
    await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    requests = [];
    const endless = Array.from({ length: AA_MAX_PAGES + 1 }, (_, i) => ({
      status: 200,
      body: page([entry(`other-${String(i)}`, 10)], true, i + 1),
    }));
    const status = await sync(fakeFetch(...endless)).sync();
    expect(status.outcome).toBe('failed');
    expect(status.message).toContain(String(AA_MAX_PAGES));
    expect(requests).toHaveLength(AA_MAX_PAGES);
    expect(listAaModels(state.db).map((m) => m.slug)).toEqual(['claude-opus-5-5-high']);
    expect(opusHigh()?.scores.intelligence).toBe(50);
  });

  it('clears a profile AA stops listing, names it, and leaves manual profiles alone', async () => {
    const manual = findModelProfile(state.db, 'claude', 'sonnet', 'high');
    if (!manual) throw new Error('not seeded');
    state.write((ctx) => patchModelProfile(ctx, manual.id, { costPerTaskUsd: 9 }));
    await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    expect(opusHigh()?.scores.intelligence).toBe(50);
    const status = await sync(
      fakeFetch({ status: 200, body: page([entry('other-lab-model', 30)], false) }),
    ).sync();
    expect(status.outcome).toBe('ok');
    expect(opusHigh()).toMatchObject({
      scores: { intelligence: null, coding: null, agentic: null },
      costPerTaskUsd: null,
    });
    expect(status.unmeasuredProfiles).toContain('opus@high');
    expect(findModelProfile(state.db, 'claude', 'sonnet', 'high')).toMatchObject({
      source: 'manual',
      costPerTaskUsd: 9,
    });
  });

  it('resolves with a status when the database fails on reads and writes alike', async () => {
    const closed = new Proxy(state.db, {
      get() {
        throw new Error('database is closed');
      },
    });
    const failing: StateStore = {
      ...state,
      db: closed,
      write: () => {
        throw new Error('database is closed');
      },
    };
    const status = await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
      KEY,
      failing,
    ).sync();
    expect(status.outcome).toBe('failed');
    expect(status.models).toBe(0);
  });

  it('reports a listed profile AA gives no cost as unmeasured', async () => {
    const unpriced = {
      ...entry('claude-opus-5-5-high', 50),
      artificial_analysis_intelligence_index_cost: null,
    };
    const status = await sync(fakeFetch({ status: 200, body: page([unpriced], false) })).sync();
    expect(status.outcome).toBe('ok');
    expect(status.unmeasuredProfiles).toContain('opus@high');
  });

  it('reports a listed profile with no coding or agentic score as missing scores, not unmeasured', async () => {
    const partial = {
      ...entry('claude-opus-5-5-high', 50),
      evaluations: { artificial_analysis_intelligence_index: 50 },
    };
    const status = await sync(fakeFetch({ status: 200, body: page([partial], false) })).sync();
    expect(status.unmeasuredProfiles).not.toContain('opus@high');
    expect(status.missingScores).toContainEqual({
      profile: 'opus@high',
      kinds: ['coding', 'agentic'],
    });
    expect(status.missingScores.map((m) => m.profile)).not.toContain('fable@max');
  });

  it('reports a listed profile with no intelligence score as unmeasured', async () => {
    const noIntelligence = {
      ...entry('claude-opus-5-5-high', 50),
      evaluations: { artificial_analysis_coding_index: 49 },
    };
    const status = await sync(
      fakeFetch({ status: 200, body: page([noIntelligence], false) }),
    ).sync();
    expect(status.unmeasuredProfiles).toContain('opus@high');
    expect(status.missingScores.map((m) => m.profile)).not.toContain('opus@high');
  });

  it('reports an unlisted profile as unmeasured and a fully scored one as neither', async () => {
    const status = await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    expect(status.unmeasuredProfiles).toContain('opus@medium');
    expect(status.missingScores.map((m) => m.profile)).not.toContain('opus@medium');
    expect(status.unmeasuredProfiles).not.toContain('opus@high');
    expect(status.missingScores.map((m) => m.profile)).not.toContain('opus@high');
  });

  it('reads a status stored before missing scores were recorded', () => {
    const s = sync(fakeFetch());
    state.write((ctx) => {
      setAppSetting(ctx, 'benchmarks.status', {
        keyConfigured: true,
        lastSyncAt: null,
        lastSuccessAt: null,
        outcome: null,
        message: null,
        unmeasuredProfiles: [],
      });
    });
    expect(s.status().missingScores).toEqual([]);
    expect(s.status().indexVersion).toBeNull();
  });

  describe('index version', () => {
    const warnings: { obj: object; msg: string | undefined }[] = [];
    const warnLogger: BenchmarkSyncDeps['logger'] = {
      ...silentLogger,
      warn: (obj, msg) => {
        warnings.push({ obj, msg });
      },
    };
    const syncOn = (version: string) =>
      createBenchmarkSync({
        state,
        clock,
        fetch: fakeFetch({
          status: 200,
          body: page([entry('claude-opus-5-5-high', 50)], false, 1, version),
        }),
        readKey: () => KEY,
        logger: warnLogger,
      }).sync();
    beforeEach(() => {
      warnings.length = 0;
    });

    it.each([
      { name: 'a minor change', from: '8.1', to: '8.2', changed: false },
      { name: 'no change', from: '8.2', to: '8.2', changed: false },
      { name: 'a major change', from: '8.2', to: '9.0', changed: true },
    ])('handles $name', async ({ from, to, changed }) => {
      const first = await syncOn(from);
      expect(first.indexVersion).toBe(from);
      expect(first.message).not.toContain('major version');
      warnings.length = 0;
      const second = await syncOn(to);
      expect(second.indexVersion).toBe(to);
      if (changed) {
        expect(second.message).toContain(
          'Intelligence Index major version changed from 8 to 9; review the step needs and floors.',
        );
        expect(warnings).toHaveLength(1);
        expect(JSON.stringify(warnings[0]?.obj)).toBe(JSON.stringify({ from, to }));
      } else {
        expect(second.message).not.toContain('major version');
        expect(warnings).toEqual([]);
      }
    });

    it('keeps the last version through a failed sync', async () => {
      await syncOn('8.1');
      const failed = await sync(fakeFetch({ status: 503 })).sync();
      expect(failed.indexVersion).toBe('8.1');
    });
  });

  it('records a database failure as a failed sync instead of rejecting', async () => {
    const failing: StateStore = {
      ...state,
      write: () => {
        throw new Error('disk I/O error');
      },
    };
    const status = await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
      KEY,
      failing,
    ).sync();
    expect(status.outcome).toBe('failed');
    expect(status.message).toContain('Error');
    expect(listAaModels(state.db)).toEqual([]);
  });

  it('leaves a profile the builder edited alone', async () => {
    const profile = opusHigh();
    if (!profile) throw new Error('not seeded');
    state.write((ctx) => patchModelProfile(ctx, profile.id, { costPerTaskUsd: 9 }));
    await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    expect(opusHigh()).toMatchObject({
      source: 'manual',
      costPerTaskUsd: 9,
      scores: { intelligence: null },
    });
  });

  it('syncs at start when the last success is stale, then once a day', async () => {
    const replies = () => ({
      status: 200,
      body: page([entry('claude-opus-5-5-high', 50)], false),
    });
    const s = sync(fakeFetch(replies(), replies(), replies()));
    s.start();
    await vi.waitFor(() => {
      expect(s.status().lastSuccessAt).not.toBeNull();
    });
    expect(requests).toHaveLength(1);
    clock.advance(AA_SYNC_INTERVAL_MS - 1);
    expect(requests).toHaveLength(1);
    clock.advance(1);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    s.stop();
    clock.advance(AA_SYNC_INTERVAL_MS * 2);
    expect(requests).toHaveLength(2); // stopped: no timer re-arms
  });

  it('does not sync at start when the last success is recent', async () => {
    await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    requests = [];
    const s = sync(fakeFetch());
    s.start();
    expect(requests).toHaveLength(0);
    s.stop();
  });
});
