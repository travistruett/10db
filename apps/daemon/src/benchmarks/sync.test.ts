import {
  createTestStore,
  findModelProfile,
  listAaModels,
  patchModelProfile,
  setAppSetting,
  upsertModelProfiles,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { seedProfiles } from '../../test/seed-profiles';
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
const opusHigh = () => findModelProfile(state.db, 'claude', 'claude-opus-5-5', 'high');

describe('benchmark sync', () => {
  beforeEach(() => {
    seedProfiles(state);
  });

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
    expect(status.unmeasuredProfiles).toContain('claude-opus-5-5@medium');
    expect(status.unmeasuredProfiles).not.toContain('claude-opus-5-5@high');
    expect(status.unmeasuredProfiles).not.toContain('claude-opus-5@max'); // disabled profiles are not reported
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
    const manual = findModelProfile(state.db, 'claude', 'claude-sonnet-5-5', 'high');
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
    expect(status.unmeasuredProfiles).toContain('claude-opus-5-5@high');
    expect(findModelProfile(state.db, 'claude', 'claude-sonnet-5-5', 'high')).toMatchObject({
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
    expect(status.unmeasuredProfiles).toContain('claude-opus-5-5@high');
  });

  it('reports a listed profile with no coding or agentic score as missing scores, not unmeasured', async () => {
    const partial = {
      ...entry('claude-opus-5-5-high', 50),
      evaluations: { artificial_analysis_intelligence_index: 50 },
    };
    const status = await sync(fakeFetch({ status: 200, body: page([partial], false) })).sync();
    expect(status.unmeasuredProfiles).not.toContain('claude-opus-5-5@high');
    expect(status.missingScores).toContainEqual({
      profile: 'claude-opus-5-5@high',
      kinds: ['coding', 'agentic'],
    });
    expect(status.missingScores.map((m) => m.profile)).not.toContain('claude-opus-5@max');
  });

  it('reports a listed profile with no intelligence score as unmeasured', async () => {
    const noIntelligence = {
      ...entry('claude-opus-5-5-high', 50),
      evaluations: { artificial_analysis_coding_index: 49 },
    };
    const status = await sync(
      fakeFetch({ status: 200, body: page([noIntelligence], false) }),
    ).sync();
    expect(status.unmeasuredProfiles).toContain('claude-opus-5-5@high');
    expect(status.missingScores).toContainEqual({
      profile: 'claude-opus-5-5@high',
      kinds: ['intelligence', 'agentic'],
    });
  });

  it('reports an unlisted profile as unmeasured and a fully scored one as neither', async () => {
    const status = await sync(
      fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }),
    ).sync();
    expect(status.unmeasuredProfiles).toContain('claude-opus-5-5@medium');
    expect(status.missingScores.map((m) => m.profile)).not.toContain('claude-opus-5-5@medium');
    expect(status.unmeasuredProfiles).not.toContain('claude-opus-5-5@high');
    expect(status.missingScores.map((m) => m.profile)).not.toContain('claude-opus-5-5@high');
  });

  it('reads a status stored before missing scores were recorded', () => {
    const s = sync(fakeFetch());
    state.write((ctx) => {
      setAppSetting(ctx, 'benchmarks.status', {
        keyConfigured: true,
        lastSyncAt: null,
        lastSuccessAt: null,
        outcome: null,
        message: 'stored earlier',
        unmeasuredProfiles: ['claude-opus-5-5@low'],
      });
    });
    expect(s.status()).toMatchObject({
      keyConfigured: true,
      message: 'stored earlier',
      unmeasuredProfiles: ['claude-opus-5-5@low'],
      missingScores: [],
      indexVersion: null,
    });
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

    it('does not flag a numeric version followed by a string one in the same major', async () => {
      const numeric = await createBenchmarkSync({
        state,
        clock,
        fetch: fakeFetch({
          status: 200,
          body: {
            ...page([entry('claude-opus-5-5-high', 50)], false),
            intelligence_index_version: 4.3,
          },
        }),
        readKey: () => KEY,
        logger: warnLogger,
      }).sync();
      expect(numeric.indexVersion).toBe('4.3');
      const next = await syncOn('4.9');
      expect(next.message).not.toContain('major version');
      expect(warnings).toEqual([]);
    });

    it('flags a major change that spans a failed sync', async () => {
      await syncOn('8.1');
      await sync(fakeFetch({ status: 503 })).sync();
      const after = await syncOn('9.0');
      expect(after.message).toContain('changed from 8 to 9');
      expect(warnings).toHaveLength(1);
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

describe('retry after a failed sync', () => {
  const MINUTE = 60_000;
  /** The wait after each failure in a row, in minutes: 15 doubling, capped at 6 hours. */
  const RETRY_WAITS_MINUTES = [15, 30, 60, 120, 240, 360, 360];
  const OK = { status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) };

  /**
   * Resolves once the attempt that ran at the clock's current time has recorded its outcome and its
   * promise chain has cleared the running sync. The yield to a real macrotask is what lets that chain
   * finish; the clock under test is the injected one, so no time passes here.
   */
  const recorded = async (s: ReturnType<typeof sync>): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await vi.waitFor(() => {
      expect(s.status().lastSyncAt).toBe(clock.now().toISOString());
    });
  };

  it.each([
    { name: 'a rejected key', reply: { status: 401 }, outcome: 'unauthorized' },
    {
      name: 'the rate limit',
      reply: { status: 429, headers: { 'Retry-After': '3600' } },
      outcome: 'rate_limited',
    },
    { name: 'a server error', reply: { status: 503 }, outcome: 'failed' },
    { name: 'a network error', reply: 'network-error' as const, outcome: 'failed' },
  ])('retries 15 minutes after a failure on $name', async ({ reply, outcome }) => {
    const s = sync(fakeFetch(reply, OK));
    s.start();
    await recorded(s);
    expect(s.status().outcome).toBe(outcome);
    clock.advance(15 * MINUTE - 1);
    expect(requests).toHaveLength(1);
    clock.advance(1);
    expect(requests).toHaveLength(2);
    await recorded(s);
    expect(s.status().outcome).toBe('ok');
  });

  it('doubles the wait after each failure in a row, capped at 6 hours', async () => {
    const s = sync(
      fakeFetch(...Array.from({ length: RETRY_WAITS_MINUTES.length + 1 }, () => ({ status: 503 }))),
    );
    s.start();
    await recorded(s);
    for (const [i, minutes] of RETRY_WAITS_MINUTES.entries()) {
      clock.advance(minutes * MINUTE - 1);
      expect(requests).toHaveLength(i + 1);
      clock.advance(1);
      expect(requests).toHaveLength(i + 2);
      await recorded(s);
    }
  });

  it('goes back to the daily sync after a retry succeeds, and the next failure starts the backoff again', async () => {
    const s = sync(fakeFetch({ status: 503 }, { status: 503 }, OK, { status: 503 }, OK));
    s.start();
    await recorded(s);
    clock.advance(15 * MINUTE);
    await recorded(s);
    clock.advance(30 * MINUTE);
    await recorded(s);
    expect(s.status().outcome).toBe('ok');
    clock.advance(AA_SYNC_INTERVAL_MS - 1);
    expect(requests).toHaveLength(3);
    clock.advance(1);
    expect(requests).toHaveLength(4);
    await recorded(s);
    expect(s.status().outcome).toBe('failed');
    clock.advance(15 * MINUTE - 1);
    expect(requests).toHaveLength(4);
    clock.advance(1);
    expect(requests).toHaveLength(5);
  });

  it('waits for the daily sync, not the backoff, when no key is configured', async () => {
    const s = sync(fakeFetch(), null);
    s.start();
    await recorded(s);
    expect(s.status().outcome).toBe('no_key');
    const checkedAt = s.status().lastSyncAt;
    clock.advance(15 * MINUTE);
    expect(s.status().lastSyncAt).toBe(checkedAt);
    clock.advance(AA_SYNC_INTERVAL_MS - 15 * MINUTE);
    expect(s.status().lastSyncAt).not.toBe(checkedAt);
  });

  it('stop cancels a pending retry', async () => {
    const s = sync(fakeFetch({ status: 503 }, OK));
    s.start();
    await recorded(s);
    s.stop();
    clock.advance(AA_SYNC_INTERVAL_MS * 2);
    expect(requests).toHaveLength(1);
  });

  it('retries at start when the last sync failed, even though the last success is recent', async () => {
    await sync(fakeFetch(OK)).sync();
    clock.advance(AA_SYNC_INTERVAL_MS / 2);
    await sync(fakeFetch({ status: 503 })).sync();
    clock.advance(MINUTE);
    requests = [];
    const s = sync(fakeFetch(OK));
    s.start();
    await recorded(s);
    expect(requests).toHaveLength(1);
    expect(s.status().outcome).toBe('ok');
  });
});

describe('scores after a catalogue change', () => {
  const OK = (...slugs: string[]) => ({
    status: 200,
    body: page(
      slugs.map((slug, i) => entry(slug, 40 + i)),
      false,
    ),
  });
  /** Catalogue-built rows: canonical IDs, no AA slug yet, as `reconcileProfiles` writes them. */
  const offer = (model: string, ...efforts: ('low' | 'high' | 'max')[]) => {
    state.write((ctx) => {
      upsertModelProfiles(
        ctx,
        efforts.map((effort) => ({
          provider: 'codex' as const,
          model,
          effort,
          aaSlug: null,
          enabled: false,
          maker: null,
          family: null,
          tier: null,
          status: 'current' as const,
          inputPrice: null,
          outputPrice: null,
          releaseDate: null,
        })),
      );
    });
  };
  const row = (model: string, effort: 'low' | 'high' | 'max') =>
    findModelProfile(state.db, 'codex', model, effort);
  const DAY = AA_SYNC_INTERVAL_MS;

  it('fills the slug of each offered effort AA lists and leaves an unlisted one unscored, without an error', async () => {
    offer('lab-x-1.2', 'low', 'high', 'max');
    const status = await sync(fakeFetch(OK('lab-x-1-2-high', 'lab-x-1-2'))).syncForCatalogue({
      force: false,
    });
    expect(status).toMatchObject({ outcome: 'ok' });
    expect(row('lab-x-1.2', 'high')).toMatchObject({
      aaSlug: 'lab-x-1-2-high',
      scores: { intelligence: 40 },
    });
    expect(row('lab-x-1.2', 'max')).toMatchObject({
      aaSlug: 'lab-x-1-2',
      scores: { intelligence: 41 },
    });
    expect(row('lab-x-1.2', 'low')).toMatchObject({ aaSlug: null, scores: { intelligence: null } });
    expect(requests).toHaveLength(1);
  });

  it('asks once for a change of offered models, not again for the same ones, and again for a new one', async () => {
    const s = sync(fakeFetch(OK('lab-x-1-high'), OK('lab-x-1-high', 'lab-y-2-high'), OK()));
    offer('lab-x-1', 'high');
    await s.syncForCatalogue({ force: false });
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(1);
    offer('lab-y-2', 'high');
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(2);
    expect(row('lab-y-2', 'high')?.scores.intelligence).toBe(41);
  });

  it('asks on every forced refresh, one request each', async () => {
    const s = sync(fakeFetch(OK('lab-x-1-high'), OK('lab-x-1-high')));
    offer('lab-x-1', 'high');
    await s.syncForCatalogue({ force: false });
    await s.syncForCatalogue({ force: true });
    expect(requests).toHaveLength(2);
  });

  it('asks again once a day while an offered model has no score, and not sooner', async () => {
    const s = sync(fakeFetch(OK('other-lab'), OK('other-lab'), OK('lab-x-1-high')));
    offer('lab-x-1', 'high');
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(1);
    clock.advance(DAY - 1);
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(1);
    clock.advance(1);
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(2);
    expect(row('lab-x-1', 'high')?.scores.intelligence).toBeNull();
    clock.advance(DAY);
    await s.syncForCatalogue({ force: false });
    expect(row('lab-x-1', 'high')?.scores.intelligence).toBe(40);
  });

  it('does not ask on a timer of its own once every offered model is scored', async () => {
    const s = sync(fakeFetch(OK('lab-x-1-high'), OK('lab-x-1-high')));
    offer('lab-x-1', 'high');
    await s.syncForCatalogue({ force: false });
    clock.advance(DAY * 3);
    await s.syncForCatalogue({ force: false });
    expect(requests).toHaveLength(1);
  });

  it('fetches nothing without a key, forced or not', async () => {
    offer('lab-x-1', 'high');
    const s = sync(fakeFetch(), null);
    await s.syncForCatalogue({ force: false });
    const status = await s.syncForCatalogue({ force: true });
    expect(status.outcome).toBe('no_key');
    expect(requests).toEqual([]);
  });
});
