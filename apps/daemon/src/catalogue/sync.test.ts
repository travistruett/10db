import { CatalogueSource } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { readModelsDevFixture as readFixture } from '../../test/models-dev-fixture';
import { CATALOGUE_URL, parseCatalogue, type Catalogue } from './index';
import { CATALOGUE_SYNC_INTERVAL_MS, createCatalogueSync } from './sync';

const MINUTE = 60 * 1000;
const FIXTURE_MODELS = 18;

let state: StateStore;
let close: () => void;
let clock: ManualClock;
let requested: string[];
let changed: Catalogue[];
beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-06T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  requested = [];
  changed = [];
});
afterEach(() => {
  close();
});

/** A reply carries a JSON body, or `raw` text that is not JSON. */
type Reply = { status: number; body?: unknown; raw?: string } | 'network-error';
function fakeFetch(...replies: Reply[]): typeof fetch {
  return (input) => {
    requested.push(input instanceof Request ? input.url : input.toString());
    const reply = replies.shift() ?? { status: 500 };
    if (reply === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status }),
    );
  };
}
const ok = (body: unknown = readFixture()): Reply => ({ status: 200, body });

/** The fixture with one more model, so its hash differs. */
function withExtraModel(): unknown {
  const raw = z
    .object({ anthropic: z.object({ models: z.record(z.string(), z.unknown()) }) })
    .loose()
    .parse(structuredClone(readFixture()));
  raw.anthropic.models['claude-new'] = { id: 'claude-new', name: 'New', cost: { output: 3 } };
  return raw;
}

/** The sync re-arms its timer once a fetch settles, which is the moment to move the clock. */
const armed = () =>
  vi.waitFor(() => {
    expect(clock.pendingTimers()).toBe(1);
  });

const catalogueSync = (
  fetchImpl: typeof fetch,
  snapshot: () => Catalogue | null = () => null,
  store: StateStore = state,
  onChanged: (c: Catalogue) => void | Promise<void> = (c) => {
    changed.push(c);
  },
) =>
  createCatalogueSync({
    state: store,
    clock,
    fetch: fetchImpl,
    logger: silentLogger,
    snapshot,
    onChanged,
  });

describe('catalogue sync', () => {
  it('fetches models.dev, stores the catalogue and reports it as fetched', async () => {
    const status = await catalogueSync(fakeFetch(ok())).sync();
    expect(requested).toEqual([CATALOGUE_URL]);
    expect(status).toEqual({
      fetchedAt: '2026-11-06T12:00:00.000Z',
      source: CatalogueSource.Fetched,
      models: FIXTURE_MODELS,
    });
    expect(changed).toHaveLength(1);
  });

  it('serves a stored catalogue after a restart, before any fetch', async () => {
    await catalogueSync(fakeFetch(ok())).sync();
    clock.advance(MINUTE);
    const restarted = catalogueSync(fakeFetch());
    expect(restarted.status()).toEqual({
      fetchedAt: '2026-11-06T12:00:00.000Z',
      source: CatalogueSource.Stored,
      models: FIXTURE_MODELS,
    });
    expect(restarted.catalogue()?.hash).toBe(parseCatalogue(readFixture()).hash);
  });

  it('calls onChanged for a changed hash once, and not for an unchanged one', async () => {
    const s = catalogueSync(fakeFetch(ok(), ok(), ok(withExtraModel()), ok(withExtraModel())));
    await s.sync();
    clock.advance(MINUTE);
    const again = await s.sync();
    expect(changed).toHaveLength(1);
    expect(again.fetchedAt).toBe('2026-11-06T12:01:00.000Z');
    await s.sync();
    expect(changed).toHaveLength(2);
    expect(s.status().models).toBe(FIXTURE_MODELS + 1);
    await s.sync();
    expect(changed).toHaveLength(2);
  });

  it('does not call onChanged for the first fetch when the snapshot already holds that catalogue', async () => {
    await catalogueSync(fakeFetch(ok()), () => parseCatalogue(readFixture())).sync();
    expect(changed).toHaveLength(0);
  });

  it.each([
    ['a network error', 'network-error' as const],
    ['a server error', { status: 503 }],
    ['a document that is not an object', ok([])],
    ['a document with none of the providers', ok({ deepinfra: { models: {} } })],
    ['a body that is not JSON', { status: 200, raw: '<html>' }],
    [
      'a document whose every entry fails validation',
      ok({
        ...z.record(z.string(), z.unknown()).parse(readFixture()),
        anthropic: { models: { x: { name: 'x' } } },
      }),
    ],
    ['a document that lists a provider with no models', ok({ anthropic: { models: {} } })],
  ])('keeps the stored copy after %s', async (_name, reply) => {
    const s = catalogueSync(fakeFetch(ok(), reply));
    await s.sync();
    changed = [];
    clock.advance(MINUTE);
    const status = await s.sync();
    expect(status).toEqual({
      fetchedAt: '2026-11-06T12:00:00.000Z',
      source: CatalogueSource.Fetched,
      models: FIXTURE_MODELS,
    });
    expect(changed).toHaveLength(0);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('now');
      },
    ],
    ['rejects', () => Promise.reject(new Error('later'))],
  ])('delivers the change on the next sync after onChanged %s', async (_name, fail) => {
    let calls = 0;
    const s = catalogueSync(
      fakeFetch(ok(), ok(), ok()),
      () => null,
      state,
      (c) => {
        calls += 1;
        if (calls === 1) return fail();
        changed.push(c);
        return undefined;
      },
    );
    const first = await s.sync();
    expect(first.source).toBe(CatalogueSource.Fetched);
    expect(changed).toHaveLength(0);
    await s.sync();
    expect(changed).toHaveLength(1);
    await s.sync();
    expect(calls).toBe(2);
  });

  it('retries a change that was not delivered on the backoff, not a day later', async () => {
    let calls = 0;
    const s = catalogueSync(
      fakeFetch(ok(), ok()),
      () => null,
      state,
      (c) => {
        calls += 1;
        if (calls === 1) throw new Error('now');
        changed.push(c);
      },
    );
    s.start();
    await armed();
    clock.advance(15 * MINUTE);
    await vi.waitFor(() => {
      expect(changed).toHaveLength(1);
    });
    s.stop();
  });

  it('holds nothing in memory when the write fails, so the catalogue is still absent', async () => {
    const failing: StateStore = {
      db: state.db,
      now: () => state.now(),
      write: () => {
        throw new Error('disk full');
      },
    };
    const s = catalogueSync(fakeFetch(ok()), () => null, failing);
    expect(await s.sync()).toEqual({ fetchedAt: null, source: CatalogueSource.None, models: 0 });
    expect(s.catalogue()).toBeNull();
    expect(changed).toHaveLength(0);
  });

  it('falls back to the snapshot when the fetch fails and nothing is stored', async () => {
    const snapshot = parseCatalogue(readFixture());
    const status = await catalogueSync(fakeFetch('network-error'), () => snapshot).sync();
    expect(status).toEqual({
      fetchedAt: null,
      source: CatalogueSource.Snapshot,
      models: FIXTURE_MODELS,
    });
  });

  it('reports none when the fetch fails and there is neither a stored copy nor a snapshot', async () => {
    const s = catalogueSync(fakeFetch('network-error'));
    expect(await s.sync()).toEqual({ fetchedAt: null, source: CatalogueSource.None, models: 0 });
    expect(s.catalogue()).toBeNull();
  });

  it('prefers the stored copy to the snapshot', async () => {
    const small = parseCatalogue({
      anthropic: { models: { a: { id: 'a', name: 'A' } } },
      openai: { models: { b: { id: 'b', name: 'B' } } },
      'amazon-bedrock': { models: { c: { id: 'c', name: 'C' } } },
      openrouter: { models: { d: { id: 'd', name: 'D' } } },
    });
    const s = catalogueSync(fakeFetch(ok(), 'network-error'), () => small);
    await s.sync();
    expect((await s.sync()).models).toBe(FIXTURE_MODELS);
  });

  it('joins a fetch already running instead of making another', async () => {
    const s = catalogueSync(fakeFetch(ok(), ok()));
    await Promise.all([s.sync(), s.sync()]);
    expect(requested).toHaveLength(1);
  });

  describe('schedule', () => {
    it('fetches at start when nothing is stored, then daily', async () => {
      const s = catalogueSync(fakeFetch(ok(), ok()));
      s.start();
      await armed();
      clock.advance(CATALOGUE_SYNC_INTERVAL_MS - 1);
      expect(requested).toHaveLength(1);
      clock.advance(1);
      await vi.waitFor(() => {
        expect(requested).toHaveLength(2);
      });
      s.stop();
    });

    it('waits out the rest of the day when the stored copy is fresh', async () => {
      await catalogueSync(fakeFetch(ok())).sync();
      requested = [];
      clock.advance(CATALOGUE_SYNC_INTERVAL_MS / 2);
      const s = catalogueSync(fakeFetch(ok()));
      s.start();
      expect(requested).toHaveLength(0);
      clock.advance(CATALOGUE_SYNC_INTERVAL_MS / 2);
      await vi.waitFor(() => {
        expect(requested).toHaveLength(1);
      });
      s.stop();
    });

    it('retries a failure after 15 minutes, then 30, and stops when stopped', async () => {
      const s = catalogueSync(fakeFetch('network-error', 'network-error', ok()));
      s.start();
      await armed();
      clock.advance(15 * MINUTE - 1);
      expect(requested).toHaveLength(1);
      clock.advance(1);
      await armed();
      clock.advance(30 * MINUTE);
      await vi.waitFor(() => {
        expect(requested).toHaveLength(3);
      });
      s.stop();
      expect(clock.pendingTimers()).toBe(0);
    });
  });
});
