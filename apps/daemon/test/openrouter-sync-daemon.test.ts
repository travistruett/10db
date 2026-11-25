import { AccountCreatedDto, AccountDto, BenchmarkStatusDto, JudgeStatusDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import type { Keychain } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createMemoryKeychain, tempDir, waitForAsync } from './fixtures';

const KEY = 'sk-or-v1-0123456789abcdef-NEVER-SHOWN';
const QUIET = { caffeinate: () => null, watch: false } as const;
const BENCHMARKS = 'https://openrouter.ai/api/v1/benchmarks';
const MODELS = 'https://openrouter.ai/api/v1/models';
const DECISION_LIST = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let requests: { url: string; authorization: string | null }[];

beforeEach(() => {
  data = tempDir('openrouter sync daemon');
  daemon = null;
  requests = [];
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

const decisionModel = {
  id: 'liquid/d1',
  name: 'Liquid: D1',
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
  pricing: { prompt: '0.000000042', completion: '0' },
  endpoints: ['/api/alpha/decisions'],
};

function answer(url: string): Response {
  // The second opinion's model is a chat model on OpenRouter; it answers the test decision there.
  if (url.endsWith('/chat/completions'))
    return Response.json({
      model: 'anthropic/claude-haiku-5.5',
      choices: [{ message: { content: '{"choice":"review","confidence":0.9}' } }],
      usage: { cost: 0 },
    });
  if (url.endsWith('/systemone') || url.endsWith('/alpha/decisions'))
    return Response.json({
      model: 'typesafe/jev-1.13',
      answers: {
        decision: {
          type: 'choice',
          choice: 'review',
          confidence: 0.9,
          probabilities: { review: 0.9 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
    });
  if (url === DECISION_LIST) return Response.json({ data: [decisionModel] });
  if (url === `${BENCHMARKS}?source=artificial-analysis`)
    return Response.json({
      data: [{ model_permaslug: 'liquid/d1-20261109', intelligence_index: 12 }],
    });
  if (url === `${BENCHMARKS}?source=openrouter`)
    return Response.json({
      data: [{ model_permaslug: 'liquid/d1', benchmark_type: 'gpqa', accuracy: 0.5 }],
    });
  if (url === MODELS) return Response.json({ data: [{ id: 'liquid/d1' }] });
  return Response.json({
    data: {
      endpoints: [
        {
          provider_name: 'Alpha',
          throughput_last_30m: { p50: 70 },
          latency_last_30m: { p50: 200 },
        },
      ],
    },
  });
}

async function start(
  opts: { judgeOff?: boolean; benchmarksOff?: boolean; keychain?: Keychain } = {},
) {
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    logLevel: 'warn',
    adapter: new FakeAdapter({}),
    keychain: opts.keychain ?? createMemoryKeychain(),
    openRouterSync: true,
    ...(opts.judgeOff === undefined ? {} : { judgeOff: opts.judgeOff }),
    ...(opts.benchmarksOff === undefined ? {} : { benchmarksOff: opts.benchmarksOff }),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(answer(url));
    },
    ...QUIET,
  });
  return apiClient(daemon.url, daemon.token);
}

const openRouterStatus = async (api: ReturnType<typeof apiClient>) =>
  (await api.get('/benchmarks/status', BenchmarkStatusDto)).openRouter;

describe('the OpenRouter sync in a daemon', () => {
  it('asks nobody with no OpenRouter account, then reads once an account is picked', async () => {
    const api = await start();
    await waitForAsync(async () => (await openRouterStatus(api)).outcome === 'no_key');
    expect(requests).toEqual([]);

    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'openrouter',
      label: 'OpenRouter',
    });
    await api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: KEY });
    expect(requests).toEqual([]);
    await api.patch('/judge', JudgeStatusDto, { accountId: account.id });

    const status = await waitForAsync(async () => {
      const s = await openRouterStatus(api);
      return s.outcome === 'ok' ? s : undefined;
    });
    expect(status).toMatchObject({ keyConfigured: true, off: false });
    expect(JSON.stringify(status)).not.toContain(KEY);
    const keyed = requests.filter(
      (r) => r.url.startsWith(BENCHMARKS) || r.url.endsWith('/endpoints'),
    );
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  });
});
