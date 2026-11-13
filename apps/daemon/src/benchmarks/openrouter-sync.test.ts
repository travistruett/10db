import { createTestStore, listOpenRouterMeasures } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatalogue } from '../catalogue';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import {
  OPENROUTER_BENCHMARKS_URL,
  OPENROUTER_MODELS_URL,
  endpointsUrl,
} from './openrouter-client';
import {
  MAX_PER_MINUTE,
  RETRY_AFTER_FAILURE_MS,
  SCORES_EVERY_MS,
  SPEED_EVERY_MS,
  createOpenRouterSync,
  type OpenRouterSync,
} from './openrouter-sync';

const KEY = 'sk-or-test-key-9876';
const AA_URL = `${OPENROUTER_BENCHMARKS_URL}?source=artificial-analysis`;
const OR_URL = `${OPENROUTER_BENCHMARKS_URL}?source=openrouter`;
const OPUS = 'anthropic/claude-opus-5.5';
const OLD_STYLE = 'anthropic/claude-opus-4.9';
const OTHER_OFFERED_ELSEWHERE = 'openai/gpt-6.1-sol';
const DECISION = 'liquid/d1';

const catalogue = parseCatalogue(readModelsDevFixture());

interface Request {
  readonly url: string;
  readonly authorization: string | null;
  readonly at: number;
}

let state: StateStore;
let close: () => void;
let clock: ManualClock;
let requests: Request[];
let events: string[];
let handlers: Map<string, () => Response>;
let key: string | null;
let keys: (string | null)[];
let decisionIds: string[];
let sync: OpenRouterSync;
let onKeyRead: ((nth: number) => void) | null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const defaultAnswer = (url: string): Response => {
  if (url === AA_URL)
    return json({
      data: [
        { model_permaslug: 'anthropic/claude-opus-5.5-20261109', intelligence_index: 40 },
        { model_permaslug: 'anthropic/claude-4.9-opus-20990101', intelligence_index: 30 },
        { model_permaslug: 'acme/unlisted-20990101', intelligence_index: 20 },
      ],
    });
  if (url === OR_URL)
    return json({
      data: [
        { model_permaslug: OPUS, benchmark_type: 'gpqa', accuracy: 0.5, avg_cost_per_task: 0.2 },
      ],
    });
  if (url === OPENROUTER_MODELS_URL)
    return json({
      data: [
        { id: OPUS, canonical_slug: 'anthropic/claude-opus-5.5-20261109' },
        { id: `${OPUS}:free`, canonical_slug: 'anthropic/claude-opus-5.5-20261109' },
        { id: OLD_STYLE, canonical_slug: 'anthropic/claude-4.9-opus-20990101' },
        { id: OTHER_OFFERED_ELSEWHERE },
      ],
    });
  return json({
    data: {
      endpoints: [
        {
          provider_name: 'Alpha',
          throughput_last_30m: { p50: 60 },
          latency_last_30m: { p50: 300 },
        },
      ],
    },
  });
};

const fakeFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({
    url,
    authorization: new Headers(init?.headers).get('authorization'),
    at: clock.now().getTime(),
  });
  events.push(`request ${url}`);
  return Promise.resolve((handlers.get(url) ?? (() => defaultAnswer(url)))());
};

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  requests = [];
  events = [];
  handlers = new Map();
  key = KEY;
  keys = [];
  onKeyRead = null;
  decisionIds = [DECISION, '~typesafe/jev-latest'];
  sync = build();
});
afterEach(() => {
  sync.stop();
  close();
});

function build(): OpenRouterSync {
  return createOpenRouterSync({
    state,
    clock,
    fetch: fakeFetch,
    readKey: () => {
      events.push('readKey');
      onKeyRead?.(events.filter((e) => e === 'readKey').length);
      const next = keys.length > 0 ? (keys.shift() ?? null) : key;
      return Promise.resolve(next);
    },
    offered: () => new Set(['claude-opus-5-5']),
    catalogue: () => catalogue,
    decisionModelIds: () => Promise.resolve(decisionIds),
    logger: silentLogger,
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lets a run finish: yields to I/O and moves the clock by a second whenever the pacer is waiting. */
async function settle(run: Promise<void>): Promise<void> {
  let done = false;
  void run.then(() => {
    done = true;
  });
  const finished = (): boolean => done;
  for (let i = 0; i < 5000 && !finished(); i += 1) {
    await flush();
    if (!finished()) clock.advance(1000);
  }
  expect(finished()).toBe(true);
}

const speedUrls = (): string[] =>
  requests.map((r) => r.url).filter((u) => u.endsWith('/endpoints'));

describe('openrouter sync', () => {
  it('reads the key before any request, and with no key asks nobody, the model list included', async () => {
    key = null;
    await settle(sync.poke());
    expect(requests).toEqual([]);
    expect(events).toEqual(['readKey']);
    expect(sync.status()).toMatchObject({ keyConfigured: false, outcome: 'no_key' });
  });

  it('reads the key first, then scores once and each wanted model once', async () => {
    await settle(sync.poke());
    expect(events[0]).toBe('readKey');
    expect(requests.map((r) => r.url)).toEqual([
      OPENROUTER_MODELS_URL,
      AA_URL,
      OR_URL,
      endpointsUrl(OPUS),
      endpointsUrl(DECISION),
    ]);
    expect(requests.map((r) => r.authorization)).toEqual([
      null,
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
    ]);
    expect(sync.status()).toMatchObject({ keyConfigured: true, outcome: 'ok' });
    expect(listOpenRouterMeasures(state.db).map((r) => `${r.id}|${r.kind}|${r.key}`)).toEqual([
      'acme/unlisted|score_aa|',
      'anthropic/claude-opus-4.9|score_aa|',
      'anthropic/claude-opus-5.5|score_aa|',
      'anthropic/claude-opus-5.5|score_openrouter|gpqa',
      'anthropic/claude-opus-5.5|speed|Alpha',
      `${DECISION}|speed|Alpha`,
    ]);
  });

  it('never puts the key in the status', async () => {
    await settle(sync.poke());
    expect(JSON.stringify(sync.status())).not.toContain(KEY);
  });

  it('reads no speed again within the hour, and scores again a day later', async () => {
    await settle(sync.poke());
    const first = requests.length;
    clock.advance(SPEED_EVERY_MS / 2);
    await settle(sync.poke());
    expect(requests).toHaveLength(first);

    clock.advance(SCORES_EVERY_MS);
    await settle(sync.poke());
    expect(requests.filter((r) => r.url === AA_URL)).toHaveLength(2);
    expect(speedUrls().length).toBeGreaterThan(2);
  });

  it('never holds more than 20 requests in any 60 s window, whatever the number of models', async () => {
    decisionIds = Array.from({ length: 50 }, (_, n) => `liquid/d${String(n)}`);
    await settle(sync.poke());
    expect(speedUrls()).toHaveLength(51);
    for (const request of requests) {
      const window = requests.filter((r) => r.at >= request.at && r.at < request.at + 60_000);
      expect(window.length).toBeLessThanOrEqual(MAX_PER_MINUTE);
    }
  });

  it('keeps the old rows on a refused key, records it, and tries again an hour later', async () => {
    sync.start();
    await settle(sync.idle());
    const before = listOpenRouterMeasures(state.db);
    handlers.set(AA_URL, () => json({ error: 'no' }, 401));
    clock.advance(SCORES_EVERY_MS);
    await settle(sync.idle());
    expect(sync.status()).toMatchObject({ outcome: 'unauthorized' });
    expect(listOpenRouterMeasures(state.db)).toEqual(before);
    const count = requests.filter((r) => r.url === AA_URL).length;

    handlers.delete(AA_URL);
    clock.advance(RETRY_AFTER_FAILURE_MS - 1);
    await flush();
    expect(requests.filter((r) => r.url === AA_URL)).toHaveLength(count);
    clock.advance(1);
    await settle(sync.idle());
    expect(requests.filter((r) => r.url === AA_URL)).toHaveLength(count + 1);
    expect(sync.status()).toMatchObject({ outcome: 'ok' });
  });

  it('leaves one failed model alone and goes on, but a limit ends the run', async () => {
    decisionIds = ['liquid/a', 'liquid/b', 'liquid/c'];
    handlers.set(endpointsUrl('liquid/a'), () => json({}, 500));
    await settle(sync.poke());
    expect(
      listOpenRouterMeasures(state.db)
        .filter((r) => r.kind === 'speed')
        .map((r) => r.id),
    ).toEqual([OPUS, 'liquid/b', 'liquid/c']);
    expect(sync.status()).toMatchObject({ outcome: 'ok' });

    clock.advance(SPEED_EVERY_MS);
    handlers.set(endpointsUrl('liquid/b'), () => json({}, 429));
    const before = speedUrls().length;
    await settle(sync.poke());
    expect(sync.status()).toMatchObject({ outcome: 'rate_limited' });
    expect(speedUrls().slice(before)).toEqual([
      endpointsUrl(OPUS),
      endpointsUrl('liquid/a'),
      endpointsUrl('liquid/b'),
    ]);
  });

  it('joins a poke during a run rather than starting a second', async () => {
    const first = sync.poke();
    const second = sync.poke();
    await settle(Promise.all([first, second]).then(() => undefined));
    // The joined poke asks once more, after the run, whether the key changed; nothing else is read twice.
    expect(requests.map((r) => r.url)).toHaveLength(5);
    expect(requests.filter((r) => r.url === AA_URL)).toHaveLength(1);
  });

  it('finishes a run with the key it read, and a poke that lands meanwhile reads the new key', async () => {
    keys = [KEY, null, null];
    const run = sync.poke();
    await flush();
    void sync.poke();
    await settle(run);
    expect(
      requests
        .filter((r) => r.url !== OPENROUTER_MODELS_URL)
        .every((r) => r.authorization === `Bearer ${KEY}`),
    ).toBe(true);
    expect(sync.status()).toMatchObject({ keyConfigured: false, outcome: 'no_key' });
  });

  it('starts no further request after stop(), and arms no timer', async () => {
    decisionIds = Array.from({ length: 50 }, (_, n) => `liquid/d${String(n)}`);
    sync.start();
    for (let i = 0; i < 30; i += 1) {
      await flush();
      clock.advance(1000);
      if (requests.length >= 8) break;
    }
    sync.stop();
    const count = requests.length;
    expect(count).toBeGreaterThan(0);
    await flush();
    clock.advance(2 * SCORES_EVERY_MS);
    await flush();
    expect(requests).toHaveLength(count);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('sends nothing for a poke after stop(), even one that waited on a run unwinding', async () => {
    sync.start();
    await settle(sync.idle());
    sync.stop();
    await settle(sync.idle());
    const count = requests.length;
    const reads = events.filter((e) => e === 'readKey').length;
    await sync.poke();
    expect(requests).toHaveLength(count);
    expect(events.filter((e) => e === 'readKey')).toHaveLength(reads);
  });

  it('honours a switch of the key that lands while the recheck reads it', async () => {
    // Reads: the run's, the recheck's (a poke lands during it, and it sees no change), then the next recheck's
    // and the second run's, which see the account gone.
    keys = [KEY, KEY, null, null];
    onKeyRead = (nth) => {
      if (nth <= 2) void sync.poke();
    };
    await settle(sync.poke());
    await settle(sync.idle());
    expect(sync.status()).toMatchObject({ keyConfigured: false, outcome: 'no_key' });
  });

  it('keeps one source’s held rows when the other answers nothing usable', async () => {
    await settle(sync.poke());
    const held = (kind: string) => listOpenRouterMeasures(state.db).filter((r) => r.kind === kind);
    const aaBefore = held('score_aa');
    expect(aaBefore.length).toBeGreaterThan(0);
    clock.advance(SCORES_EVERY_MS);
    handlers.set(AA_URL, () => json({ data: [] }));
    handlers.set(OR_URL, () =>
      json({
        data: [
          { model_permaslug: OPUS, benchmark_type: 'tau', accuracy: 0.7, avg_cost_per_task: 0.3 },
        ],
      }),
    );
    await settle(sync.poke());
    expect(held('score_aa')).toEqual(aaBefore);
    expect(held('score_openrouter').map((r) => r.key)).toEqual(['tau']);
    expect(sync.status()).toMatchObject({ outcome: 'failed' });
  });
});
