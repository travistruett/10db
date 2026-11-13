import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_BENCHMARKS_URL,
  OPENROUTER_MODELS_URL,
  endpointsUrl,
  fetchEndpointStats,
  fetchOpenRouterModels,
  fetchOpenRouterScores,
} from './openrouter-client';

const KEY = 'sk-or-test-1234';

interface Call {
  readonly url: string;
  readonly authorization: string | null;
}

/** A fetch that answers each URL from a table and records what it was asked. */
function fakeFetch(answers: Record<string, () => Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    const answer = answers[url];
    if (answer === undefined) return Promise.reject(new TypeError(`unexpected ${url}`));
    return Promise.resolve(answer());
  };
  return { fetch: impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AA_URL = `${OPENROUTER_BENCHMARKS_URL}?source=artificial-analysis`;
const OR_URL = `${OPENROUTER_BENCHMARKS_URL}?source=openrouter`;

describe('fetchOpenRouterScores', () => {
  it('reads an AA item with its permaslug as sent and no benchmark, accuracy or cost', async () => {
    const { fetch } = fakeFetch({
      [AA_URL]: () =>
        json({
          data: [
            {
              model_permaslug: 'acme/model-one-20260101',
              display_name: 'Model One',
              intelligence_index: 41.5,
              coding_index: 33,
              agentic_index: null,
            },
          ],
        }),
      [OR_URL]: () => json({ data: [] }),
    });
    expect(await fetchOpenRouterScores({ fetch, key: KEY })).toEqual({
      kind: 'ok',
      value: [
        {
          permaslug: 'acme/model-one-20260101',
          source: 'aa',
          intelligence: 41.5,
          coding: 33,
          agentic: null,
          benchmark: null,
          accuracy: null,
          costPerTaskUsd: null,
        },
      ],
    });
  });

  it('reads an OpenRouter item with its benchmark, accuracy and cost per task', async () => {
    const { fetch } = fakeFetch({
      [AA_URL]: () => json({ data: [] }),
      [OR_URL]: () =>
        json({
          data: [
            {
              model_permaslug: 'acme/model-two',
              benchmark_type: 'gpqa',
              accuracy: 0.62,
              avg_cost_per_task: 0.013,
              total_tasks: 10,
              last_run_timestamp: '2026-11-01T00:00:00Z',
            },
          ],
        }),
    });
    expect(await fetchOpenRouterScores({ fetch, key: KEY })).toEqual({
      kind: 'ok',
      value: [
        {
          permaslug: 'acme/model-two',
          source: 'openrouter',
          intelligence: null,
          coding: null,
          agentic: null,
          benchmark: 'gpqa',
          accuracy: 0.62,
          costPerTaskUsd: 0.013,
        },
      ],
    });
  });

  it('drops one malformed item and keeps the good ones around it', async () => {
    const { fetch } = fakeFetch({
      [AA_URL]: () =>
        json({
          data: [
            { model_permaslug: 'acme/a-20260101', intelligence_index: 10 },
            { model_permaslug: 42, intelligence_index: 'high' },
            { model_permaslug: 'acme/b', intelligence_index: 20 },
          ],
        }),
      [OR_URL]: () => json({ data: [] }),
    });
    const outcome = await fetchOpenRouterScores({ fetch, key: KEY });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok')
      expect(outcome.value.map((r) => r.permaslug)).toEqual(['acme/a-20260101', 'acme/b']);
  });

  it('asks with the key, AA first', async () => {
    const { fetch, calls } = fakeFetch({
      [AA_URL]: () => json({ data: [] }),
      [OR_URL]: () => json({ data: [] }),
    });
    await fetchOpenRouterScores({ fetch, key: KEY });
    expect(calls).toEqual([
      { url: AA_URL, authorization: `Bearer ${KEY}` },
      { url: OR_URL, authorization: `Bearer ${KEY}` },
    ]);
  });

  it.each([
    { name: '401', status: 401, kind: 'unauthorized' },
    { name: '429', status: 429, kind: 'rate_limited' },
    { name: '500', status: 500, kind: 'failed' },
  ])('answers $name as $kind', async ({ status, kind }) => {
    const { fetch } = fakeFetch({ [AA_URL]: () => json({ error: 'no' }, status) });
    expect(await fetchOpenRouterScores({ fetch, key: KEY })).toMatchObject({ kind });
  });

  it('answers an unparseable body as failed', async () => {
    const { fetch } = fakeFetch({ [AA_URL]: () => new Response('<html>', { status: 200 }) });
    expect(await fetchOpenRouterScores({ fetch, key: KEY })).toMatchObject({ kind: 'failed' });
  });

  it('answers a failed second read as failed, not as the first read alone', async () => {
    const { fetch } = fakeFetch({
      [AA_URL]: () => json({ data: [] }),
      [OR_URL]: () => json({}, 503),
    });
    expect(await fetchOpenRouterScores({ fetch, key: KEY })).toMatchObject({ kind: 'failed' });
  });

  it('never repeats the key in a message', async () => {
    const { fetch } = fakeFetch({
      [AA_URL]: () => new Response(`bad key ${KEY} given`, { status: 500 }),
    });
    const outcome = await fetchOpenRouterScores({ fetch, key: KEY });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'ok') {
      expect(outcome.message).not.toContain(KEY);
      expect(outcome.message).toContain('[key]');
    }
  });

  it('never repeats the key when the network error names it', async () => {
    const outcome = await fetchOpenRouterScores({
      fetch: () => Promise.reject(new Error(`boom ${KEY}`)),
      key: KEY,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'ok') expect(outcome.message).not.toContain(KEY);
  });
});

describe('fetchOpenRouterModels', () => {
  it('reads each id with its canonical slug, null where it has none, without a key', async () => {
    const { fetch, calls } = fakeFetch({
      [OPENROUTER_MODELS_URL]: () =>
        json({
          data: [
            { id: 'acme/a', canonical_slug: 'acme/a-20990101' },
            { id: 7 },
            { id: 'acme/b', canonical_slug: null },
            { id: 'acme/c' },
          ],
        }),
    });
    expect(await fetchOpenRouterModels({ fetch })).toEqual({
      kind: 'ok',
      value: [
        { id: 'acme/a', canonicalSlug: 'acme/a-20990101' },
        { id: 'acme/b', canonicalSlug: null },
        { id: 'acme/c', canonicalSlug: null },
      ],
    });
    expect(calls).toEqual([{ url: OPENROUTER_MODELS_URL, authorization: null }]);
  });
});

describe('fetchEndpointStats', () => {
  const url = endpointsUrl('acme/model-one');

  it('builds the endpoints url from the id', () => {
    expect(url).toBe('https://openrouter.ai/api/v1/models/acme/model-one/endpoints');
  });

  it('reads the p50s, and a null throughput as null, never zero', async () => {
    const { fetch, calls } = fakeFetch({
      [url]: () =>
        json({
          data: {
            endpoints: [
              {
                provider_name: 'Alpha',
                throughput_last_30m: { p50: 88.5, p75: 99, p90: 110, p99: 120 },
                latency_last_30m: { p50: 410, p75: 500, p90: 600, p99: 900 },
              },
              { provider_name: 'Beta', throughput_last_30m: null, latency_last_30m: null },
              { provider_name: 7 },
            ],
          },
        }),
    });
    expect(await fetchEndpointStats({ fetch, key: KEY, id: 'acme/model-one' })).toEqual({
      kind: 'ok',
      value: [
        { provider: 'Alpha', tokensPerSecond: 88.5, latencyMs: 410 },
        { provider: 'Beta', tokensPerSecond: null, latencyMs: null },
      ],
    });
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    { status: 401, kind: 'unauthorized' },
    { status: 429, kind: 'rate_limited' },
    { status: 502, kind: 'failed' },
  ])('answers $status as $kind', async ({ status, kind }) => {
    const { fetch } = fakeFetch({ [url]: () => json({}, status) });
    expect(await fetchEndpointStats({ fetch, key: KEY, id: 'acme/model-one' })).toMatchObject({
      kind,
    });
  });
});
