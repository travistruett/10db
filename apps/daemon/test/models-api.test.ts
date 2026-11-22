import {
  AccountCreatedDto,
  AccountDto,
  JudgeStatusDto,
  ModelRowDto,
  type Effort,
} from '@10db/contracts';
import {
  findModelProfile,
  listAccountModels,
  replaceAccountModels,
  replaceEndpointStats,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, tempDir, waitFor } from './fixtures';
import { readModelsDevFixture } from './models-dev-fixture';

const QUIET = { caffeinate: () => null, watch: false } as const;
const EFFORTS: Effort[] = ['low', 'high'];

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  data = tempDir('models api');
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

/** A daemon whose one account lists the models given, against the committed catalogue fixture. */
async function start(
  models: { id: string; resolvedId: string }[],
  opts: {
    catalogueSync?: boolean;
    offline?: { value: boolean };
    openRouterSync?: boolean;
    judgeOff?: boolean;
    benchmarksOff?: boolean;
  } = {},
) {
  const adapter = new FakeAdapter({});
  adapter.probeSeen = {
    ...adapter.probeSeen,
    models: models.map((m) => ({ ...m, efforts: EFFORTS })),
  };
  const running = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    ...QUIET,
    catalogueSync: opts.catalogueSync ?? true,
    ...(opts.openRouterSync === undefined ? {} : { openRouterSync: opts.openRouterSync }),
    ...(opts.judgeOff === true ? { judgeOff: true } : {}),
    ...(opts.benchmarksOff === true ? { benchmarksOff: true } : {}),
    keychain: createMemoryKeychain(),
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // The test decision a switch of decisions' account asks.
      if (url.endsWith('/systemone'))
        return Promise.resolve(
          Response.json({
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
          }),
        );
      if (opts.offline?.value === true) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify(readModelsDevFixture())));
    },
  });
  daemon = running;
  if (opts.catalogueSync !== false)
    await waitFor(() =>
      models.length > 0
        ? listAccountModels(running.state.db).length > 0
        : findModelProfile(running.state.db, 'claude', 'claude-opus-5-5', 'high') !== undefined,
    );
  return { running, api: apiClient(running.url, running.token) };
}

describe('the model list over HTTP', () => {
  /** A daemon with a Bedrock account that offers Opus and OpenRouter's speeds for it already stored. */
  async function withBedrockSpeeds() {
    const { running, api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }], {
      openRouterSync: true,
    });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'bedrock',
      label: 'Bedrock',
      settings: { region: 'us-west-2', awsProfile: 'dev' },
    });
    running.state.write((ctx) => {
      replaceAccountModels(ctx, account.id, [
        {
          model: 'claude-opus-5-5',
          family: 'claude-opus',
          launchId: 'us.anthropic.claude-opus-5-5',
          efforts: ['high'],
          inputPrice: null,
          outputPrice: null,
        },
      ]);
      replaceEndpointStats(
        ctx,
        'anthropic/claude-opus-5.5',
        [
          { provider: 'Amazon Bedrock', tokensPerSecond: 77, latencyMs: 150 },
          { provider: 'Anthropic', tokensPerSecond: 44, latencyMs: 100 },
        ],
        new Date().toISOString(),
      );
    });
    return { api, account };
  }

  it("shows OpenRouter's speed on the provider of the asked Bedrock account, once an OpenRouter account is picked for decisions", async () => {
    const { api, account } = await withBedrockSpeeds();
    const { account: openRouter } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'openrouter',
      label: 'OpenRouter',
    });
    await api.put(`/accounts/${openRouter.id}/secret`, AccountDto, { secret: 'a-fake-key' });
    await api.patch('/judge', JudgeStatusDto, { accountId: openRouter.id });
    const rows = await api.get(`/models?account=${account.id}`, z.array(ModelRowDto));
    expect(rows.find((r) => r.model === 'claude-opus-5-5')).toMatchObject({
      outputTokensPerSecond: 77,
      speedProvider: 'Amazon Bedrock',
      sources: { speed: 'openrouter' },
    });
  });

  it('shows none of OpenRouter’s numbers while no OpenRouter account is picked for decisions', async () => {
    const { api, account } = await withBedrockSpeeds();
    const rows = await api.get(`/models?account=${account.id}`, z.array(ModelRowDto));
    expect(rows.find((r) => r.model === 'claude-opus-5-5')).toMatchObject({
      outputTokensPerSecond: null,
      speedProvider: null,
      sources: { speed: null },
    });
  });
});
