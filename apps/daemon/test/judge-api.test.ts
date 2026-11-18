import { DEFAULT_JUDGE_CONFIG, JudgeStatusDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import type { Keychain } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let openRouterRequests: { url: string; authorization: string | null }[];
let openRouterAnswer: () => Response;
let modelListAnswer: () => Response;

const MODEL_LIST_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
const decisionModel = (id: string, name: string) => ({
  id,
  name,
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
  pricing: { prompt: '0.000000042', completion: '0' },
  endpoints: ['/api/alpha/decisions'],
});

beforeEach(() => {
  data = tempDir('judge api');
  daemon = null;
  openRouterRequests = [];
  modelListAnswer = () =>
    Response.json({
      data: [
        decisionModel('typesafe/jev-1.14', 'TypeSafe: Jev 1.14'),
        decisionModel('liquid/d1', 'Liquid: D1'),
      ],
    });
  openRouterAnswer = () =>
    Response.json({
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        decision: {
          type: 'choice',
          choice: 'skip',
          confidence: 0.9,
          probabilities: { review: 0.1, skip: 0.9 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
    });
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

async function start(opts: { keychain?: Keychain; judgeOff?: boolean } = {}) {
  const keychain = opts.keychain ?? createMemoryKeychain();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    keychain,
    ...(opts.judgeOff === undefined ? {} : { judgeOff: opts.judgeOff }),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      openRouterRequests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(url === MODEL_LIST_URL ? modelListAnswer() : openRouterAnswer());
    },
    ...QUIET,
  });
  const api = apiClient(daemon.url, daemon.token);
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url ?? ''}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon?.token ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { api, raw, keychain, daemon };
}

describe('GET /judge', () => {
  it('answers the defaults, with no key and the judge on', async () => {
    const { api } = await start();
    expect(await api.get('/judge', JudgeStatusDto)).toEqual({
      config: DEFAULT_JUDGE_CONFIG,
      account: null,
      off: false,
    });
  });

  it('is refused without the UI token', async () => {
    const { daemon: d } = await start();
    expect((await fetch(`${d.url}/judge`)).status).toBe(401);
  });
});
