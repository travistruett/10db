import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountCreatedDto,
  AccountDto,
  DecisionModelListDto,
  DecisionStatsListDto,
  JudgeCallsPageDto,
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeStatusDto,
  JudgeTestResultDto,
  mintId,
  type JudgeDecision,
  type JudgeOutcome,
} from '@10db/contracts';
import { insertJudgeCall } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { KeychainError, OPENROUTER_KEY_ACCOUNT, type Keychain } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

const KEY = 'sk-or-v1-0123456789abcdef-NEVER-SHOWN';
const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let openRouterRequests: { url: string; authorization: string | null }[];
let openRouterAnswer: () => Response;
let modelListAnswer: () => Response;

const MODEL_LIST_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
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

/** An OpenRouter account with its key set; decisions run on it unless `pick` is false. */
async function openRouterAccount(
  api: ReturnType<typeof apiClient>,
  opts: { label?: string; key?: string; pick?: boolean } = {},
) {
  const { account } = await api.post('/accounts', AccountCreatedDto, {
    kind: 'openrouter',
    label: opts.label ?? 'OpenRouter',
  });
  await api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: opts.key ?? KEY });
  if (opts.pick !== false) await api.patch('/judge', JudgeStatusDto, { accountId: account.id });
  return account;
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

  it('reads the key without blocking: the synchronous read is never used', async () => {
    const memory = createMemoryKeychain();
    const { api } = await start({
      keychain: {
        ...memory,
        read: (account) => {
          if (account.startsWith('account:')) return memory.read(account);
          throw new Error('the synchronous read blocks the event loop');
        },
      },
    });
    const account = await openRouterAccount(api);
    expect(await api.get('/judge', JudgeStatusDto)).toMatchObject({
      account: { id: account.id, label: 'OpenRouter', secretSet: true, secretState: 'set' },
    });
  });

  it.each([
    {
      name: 'changed outside 10db',
      tamper: (k: Keychain, ref: string) => {
        k.write(ref, 'sk-or-v1-someone-elses-key');
      },
      state: 'changed',
    },
    {
      name: 'gone from the Keychain',
      tamper: (k: Keychain, ref: string) => {
        k.remove(ref);
      },
      state: 'missing',
    },
  ] as const)('says the account key is $state when it was $name', async ({ tamper, state }) => {
    const { api, keychain } = await start();
    const account = await openRouterAccount(api);
    tamper(keychain, `account:${account.id}`);
    expect(await api.get('/judge', JudgeStatusDto)).toMatchObject({
      account: { id: account.id, secretSet: false, secretState: state },
    });
  });

  it('answers no account when the one named no longer resolves', async () => {
    const { api } = await start();
    const account = await openRouterAccount(api);
    await api.post(`/accounts/${account.id}/archive`, AccountDto);
    expect((await api.get('/judge', JudgeStatusDto)).account).toBeNull();
  });

  it('with the judge off reads no Keychain item at all: not the status, a list refresh, the identity route or the old key', async () => {
    const calls: string[] = [];
    const memory = createMemoryKeychain({ [OPENROUTER_KEY_ACCOUNT]: KEY });
    const watching: Keychain = {
      read: (account) => {
        calls.push(`read ${account}`);
        return memory.read(account);
      },
      readAsync: (account) => {
        calls.push(`readAsync ${account}`);
        return memory.readAsync(account);
      },
      write: (account, secret) => {
        calls.push(`write ${account}`);
        memory.write(account, secret);
      },
      remove: (account) => {
        calls.push(`remove ${account}`);
        memory.remove(account);
      },
    };
    const { api, raw, daemon: d } = await start({ judgeOff: true, keychain: watching });
    // Start must not touch the OpenRouter item or any account secret.
    expect(
      calls.filter((c) => c.includes(OPENROUTER_KEY_ACCOUNT) || c.includes('account:')),
    ).toEqual([]);
    // The account is made and keyed through the routes, whose writes are not reads; the reads are counted after.
    const account = await openRouterAccount(api);
    calls.length = 0;
    const status = await api.get('/judge', JudgeStatusDto);
    expect(status).toMatchObject({ off: true, account: { id: account.id, secretState: 'set' } });
    await d.refreshModels({ force: true });
    const identity = await raw('GET', `/accounts/${account.id}/identity`);
    expect(identity.status).toBe(400);
    expect((await raw('POST', `/accounts/${account.id}/test`)).status).toBe(409);
    expect(calls).toEqual([]);
    expect(memory.read(OPENROUTER_KEY_ACCOUNT)).toBe(KEY);
  });
});

describe('the old OpenRouter key at start', () => {
  it('moves into an OpenRouter account that decisions run on, and the old item goes', async () => {
    const memory = createMemoryKeychain({ [OPENROUTER_KEY_ACCOUNT]: KEY });
    const { api } = await start({ keychain: memory });
    const status = await api.get('/judge', JudgeStatusDto);
    expect(status.account).toMatchObject({
      label: 'OpenRouter',
      secretSet: true,
      secretState: 'set',
    });
    expect(status.config.accountId).toBe(status.account?.id);
    expect(memory.read(`account:${status.account?.id ?? ''}`)).toBe(KEY);
    expect(memory.read(OPENROUTER_KEY_ACCOUNT)).toBeNull();
  });
});

describe('PATCH /judge', () => {
  it('merges a patch and answers the status', async () => {
    const { api } = await start();
    const status = await api.patch('/judge', JudgeStatusDto, {
      enabled: false,
      decisions: { shape_ready: { floor: 0.95, enabled: false } },
    });
    expect(status.config).toEqual({
      enabled: false,
      accountId: null,
      decisions: {
        ...DEFAULT_JUDGE_CONFIG.decisions,
        shape_ready: { enabled: false, model: 'typesafe/jev-1.13', floor: 0.95 },
      },
    });
    expect(await api.get('/judge', JudgeStatusDto)).toEqual(status);
    expect(openRouterRequests).toEqual([]);
  });

  it('saves a new model only after it answers one test decision with the key decisions run on', async () => {
    const { api } = await start();
    await openRouterAccount(api);
    const status = await api.patch('/judge', JudgeStatusDto, {
      decisions: { shape_ready: { model: 'liquid/d1' } },
    });
    expect(status.config.decisions.shape_ready.model).toBe('liquid/d1');
    expect(openRouterRequests).toEqual([
      { url: MODEL_LIST_URL, authorization: null },
      { url: DECISIONS_URL, authorization: `Bearer ${KEY}` },
    ]);
  });

  it('answers 409 for a new model with the judge off, saving nothing and asking nothing', async () => {
    const { api, raw } = await start({ judgeOff: true });
    await openRouterAccount(api);
    expect(
      (await raw('PATCH', '/judge', { decisions: { shape_ready: { model: 'liquid/d1' } } })).status,
    ).toBe(409);
    expect((await api.get('/judge', JudgeStatusDto)).config.decisions.shape_ready.model).toBe(
      'typesafe/jev-1.13',
    );
    expect(openRouterRequests).toEqual([]);
  });

  it('asks nothing when the model stays the same', async () => {
    const { api } = await start();
    await openRouterAccount(api);
    await api.patch('/judge', JudgeStatusDto, {
      decisions: { shape_ready: { model: 'typesafe/jev-1.13', floor: 0.9 } },
    });
    expect(openRouterRequests).toEqual([]);
  });

  it.each([
    {
      case: 'the model fails the test decision',
      account: true,
      answer: () =>
        Response.json({ error: { message: 'Model does not answer choice' } }, { status: 400 }),
      says: /liquid\/d1 didn't answer a test decision.*Model does not answer choice/,
    },
    {
      case: 'the model answers without a confidence',
      account: true,
      answer: () =>
        Response.json({
          model: 'liquid/d1',
          answers: { decision: { type: 'choice', choice: 'skip' } },
          usage: {},
        }),
      says: /without a confidence/,
    },
    {
      case: 'there is no key to test it with',
      account: false,
      answer: () => Response.json({}),
      says: /No OpenRouter key is set/,
    },
  ])('refuses a model when $case, and keeps the one saved', async ({ account, answer, says }) => {
    openRouterAnswer = answer;
    const { api, raw } = await start();
    if (account) await openRouterAccount(api);
    const res = await raw('PATCH', '/judge', {
      enabled: false,
      decisions: { shape_ready: { model: 'liquid/d1' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(says);
    expect((await api.get('/judge', JudgeStatusDto)).config).toMatchObject({
      enabled: true,
      decisions: { shape_ready: { model: 'typesafe/jev-1.13' } },
    });
  });

  it('runs decisions on an OpenRouter account, keeps it through a patch that names none, and clears it', async () => {
    const { api } = await start();
    const account = await openRouterAccount(api, { pick: false });
    const picked = await api.patch('/judge', JudgeStatusDto, { accountId: account.id });
    expect(picked.account).toMatchObject({ id: account.id, label: 'OpenRouter' });
    expect((await api.patch('/judge', JudgeStatusDto, { enabled: false })).account?.id).toBe(
      account.id,
    );
    expect((await api.patch('/judge', JudgeStatusDto, { accountId: null })).account).toBeNull();
  });

  it('refuses an account that is not an OpenRouter account, and an unknown one', async () => {
    const { api, raw } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    expect((await raw('PATCH', '/judge', { accountId: account.id })).status).toBe(400);
    expect((await raw('PATCH', '/judge', { accountId: 'acc_nope' })).status).toBe(400);
    expect((await api.get('/judge', JudgeStatusDto)).config.accountId).toBeNull();
  });

  it.each([
    ['a floor above one', { decisions: { shape_ready: { floor: 3 } } }],
    ['an unknown decision', { decisions: { other: { enabled: true } } }],
    ['an empty model', { decisions: { shape_ready: { model: '' } } }],
  ])('answers 400 for %s and changes nothing', async (_name, body) => {
    const { api, raw } = await start();
    expect((await raw('PATCH', '/judge', body)).status).toBe(400);
    expect((await api.get('/judge', JudgeStatusDto)).config).toEqual(DEFAULT_JUDGE_CONFIG);
  });
});

describe('an OpenRouter account', () => {
  it('takes its key into its own Keychain item, never the old one', async () => {
    const { api, keychain } = await start();
    const account = await openRouterAccount(api);
    expect(keychain.read(`account:${account.id}`)).toBe(KEY);
    expect(keychain.read(OPENROUTER_KEY_ACCOUNT)).toBeNull();
  });

  it('answers 409 when the Keychain refuses, naming no key', async () => {
    const memory = createMemoryKeychain();
    const { api, raw } = await start({
      keychain: {
        ...memory,
        write: (account) => {
          throw new KeychainError(`Writing the Keychain item ${account} failed (status 36)`);
        },
      },
    });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'openrouter',
      label: 'OpenRouter',
    });
    const res = await raw('PUT', `/accounts/${account.id}/secret`, { secret: KEY });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('NEVER-SHOWN');
  });

  it('never has a key in a response, the event stream, the database or the log', async () => {
    const { api, daemon: d } = await start();
    const seen: string[] = [];
    const account = await openRouterAccount(api);
    seen.push(JSON.stringify(await api.get('/judge', z.unknown())));
    seen.push(JSON.stringify(await api.get('/accounts', z.unknown())));
    seen.push(JSON.stringify(await api.patch('/judge', z.unknown(), { enabled: true })));
    seen.push(JSON.stringify(await api.post(`/accounts/${account.id}/test`, z.unknown())));
    seen.push(JSON.stringify(await api.get('/judge/calls', z.unknown())));
    seen.push(JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown())));
    // A rejected key echoed back by the server must not reach the response either.
    openRouterAnswer = () =>
      Response.json({ error: { message: `Invalid key ${KEY}` } }, { status: 401 });
    seen.push(JSON.stringify(await api.post(`/accounts/${account.id}/test`, z.unknown())));
    for (const text of seen) expect(text).not.toContain('NEVER-SHOWN');
    await d.stop();
    const files = ['logs/daemon.log', '10db.sqlite', '10db.sqlite-wal'].map((name) =>
      join(data.path, name),
    );
    for (const file of files.filter(existsSync))
      expect(readFileSync(file).includes(KEY), file).toBe(false);
  });
});

describe('POST /accounts/:id/test', () => {
  it('calls the review model with that account key and answers model, latency and cost', async () => {
    const { api } = await start();
    const account = await openRouterAccount(api);
    const result = JudgeTestResultDto.parse(
      await api.post(`/accounts/${account.id}/test`, z.unknown()),
    );
    expect(result).toMatchObject({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      costUsd: 0.00001,
    });
    expect(openRouterRequests).toEqual([
      { url: 'https://openrouter.ai/api/v1/systemone', authorization: `Bearer ${KEY}` },
    ]);
  });

  it('sends the key of the account tested, not the one decisions run on', async () => {
    const { api } = await start();
    await openRouterAccount(api, { label: 'First', key: 'sk-or-v1-first-account-key' });
    const second = await openRouterAccount(api, {
      label: 'Second',
      key: 'sk-or-v1-second-account-key',
      pick: false,
    });
    await api.post(`/accounts/${second.id}/test`, z.unknown());
    expect(openRouterRequests.map((r) => r.authorization)).toEqual([
      'Bearer sk-or-v1-second-account-key',
    ]);
  });

  it('says there is no key, and makes no request', async () => {
    const { api } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'openrouter',
      label: 'OpenRouter',
    });
    const result = JudgeTestResultDto.parse(
      await api.post(`/accounts/${account.id}/test`, z.unknown()),
    );
    expect(result).toEqual({ ok: false, error: 'No OpenRouter key is set' });
    expect(openRouterRequests).toEqual([]);
  });

  it('sends nothing with the key of an archived account', async () => {
    const { api } = await start();
    const account = await openRouterAccount(api, { pick: false });
    await api.post(`/accounts/${account.id}/archive`, z.unknown());
    const result = JudgeTestResultDto.parse(
      await api.post(`/accounts/${account.id}/test`, z.unknown()),
    );
    expect(result).toEqual({ ok: false, error: 'No OpenRouter key is set' });
    expect(openRouterRequests).toEqual([]);
  });

  it('says why OpenRouter refused, in plain words', async () => {
    openRouterAnswer = () =>
      Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 });
    const { api } = await start();
    const account = await openRouterAccount(api);
    const result = JudgeTestResultDto.parse(
      await api.post(`/accounts/${account.id}/test`, z.unknown()),
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('401');
  });

  it.each([
    ['an unknown account', () => mintId('Account'), 404],
    ['an account that is not OpenRouter', 'claude', 400],
  ] as const)('answers %s with %i', async (_name, which, status) => {
    const { api, raw } = await start();
    const id =
      which === 'claude'
        ? (
            await api.post('/accounts', AccountCreatedDto, {
              kind: 'claude_subscription',
              label: 'Company A',
            })
          ).account.id
        : which();
    expect((await raw('POST', `/accounts/${id}/test`)).status).toBe(status);
    expect(openRouterRequests).toEqual([]);
  });
});

describe('GET /judge/models', () => {
  it("lists OpenRouter's decision models without a key, reading them once for a few hours", async () => {
    const { api } = await start();
    const first = await api.get('/judge/models', DecisionModelListDto);
    expect(first.models).toEqual([
      expect.objectContaining({ id: 'liquid/d1', maker: 'Liquid', cantCall: null }),
      expect.objectContaining({ id: 'typesafe/jev-1.14', inputUsdPerMillion: 0.042 }),
    ]);
    expect(await api.get('/judge/models', DecisionModelListDto)).toEqual(first);
    expect(openRouterRequests).toEqual([{ url: MODEL_LIST_URL, authorization: null }]);
  });

  it("gives each model its cost and time, from the builder's own calls when it has any, and never changes the list held", async () => {
    const { api, daemon: d } = await start();
    const before = await api.get('/judge/models', DecisionModelListDto);
    expect(before.models.find((m) => m.id === 'liquid/d1')).toMatchObject({
      costSource: 'assumed',
      timeSource: null,
    });
    d.state.write((ctx) => {
      insertJudgeCall(ctx, {
        decision: 'review_size',
        model: 'liquid/d1',
        state: 's',
        question: 'q',
        answer: 'skip',
        confidence: 0.9,
        outcome: 'acted',
        latencyMs: 250,
        costUsd: 0.000002,
        workstreamId: null,
        taskId: null,
      });
      insertJudgeCall(ctx, {
        decision: 'review_size',
        model: 'liquid/d1',
        state: 's',
        question: 'q',
        answer: null,
        confidence: null,
        outcome: 'fallback_timeout',
        latencyMs: 4000,
        costUsd: 9,
        workstreamId: null,
        taskId: null,
      });
    });
    const first = await api.get('/judge/models', DecisionModelListDto);
    expect(first.models.find((m) => m.id === 'liquid/d1')).toMatchObject({
      costPerMillionUsd: 2,
      costSource: 'your_calls',
      secondsPerDecision: 0.25,
      timeSource: 'your_calls',
    });
    // The other model has no calls: its price over the size your calls show.
    expect(first.models.find((m) => m.id === 'typesafe/jev-1.14')).toMatchObject({
      costSource: 'openrouter_price',
    });
    expect(await api.get('/judge/models', DecisionModelListDto)).toEqual(first);
    expect(openRouterRequests).toEqual([{ url: MODEL_LIST_URL, authorization: null }]);
  });

  it('answers 502 naming why when OpenRouter cannot be read', async () => {
    modelListAnswer = () => new Response('down', { status: 503 });
    const { raw } = await start();
    const res = await raw('GET', '/judge/models');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('503');
  });

  it('answers 409 with the judge off, and asks OpenRouter nothing', async () => {
    const { raw } = await start({ judgeOff: true });
    expect((await raw('GET', '/judge/models')).status).toBe(409);
    expect(openRouterRequests).toEqual([]);
  });
});

describe('the call log, paged, and the decision stats', () => {
  function seed(d: RunningDaemon, calls: { decision: JudgeDecision; outcome: JudgeOutcome }[]) {
    calls.forEach((c, i) => {
      d.state.write((ctx) => {
        insertJudgeCall(ctx, {
          ...c,
          model: 'liquid/d1',
          state: 'SECRET TASK TEXT',
          question: `q${String(i)}`,
          answer: 'skip',
          confidence: 0.8,
          latencyMs: 100 * (i + 1),
          costUsd: 0.001,
          workstreamId: null,
          taskId: null,
        });
      });
    });
  }
  const mix: { decision: JudgeDecision; outcome: JudgeOutcome }[] = [
    { decision: 'review_size', outcome: 'acted' },
    { decision: 'shape_ready', outcome: 'below_floor' },
    { decision: 'review_size', outcome: 'stopped' },
    { decision: 'review_size', outcome: 'fallback_timeout' },
    { decision: 'review_size', outcome: 'acted' },
  ];

  it('reads the seeded calls back filtered and paged, with the total of the filter', async () => {
    const { api, daemon: d } = await start();
    seed(d, mix);
    const page = await api.get(
      '/judge/calls/page?decision=review_size&limit=2&offset=1',
      JudgeCallsPageDto,
    );
    expect(page.calls.map((c) => c.question)).toEqual(['q3', 'q2']);
    expect(page.total).toBe(4);
    expect(JSON.stringify(page)).not.toContain('SECRET TASK TEXT');
    const acted = await api.get('/judge/calls/page?outcome=acted', JudgeCallsPageDto);
    expect(acted.calls.map((c) => c.question)).toEqual(['q4', 'q0']);
    expect(acted.total).toBe(2);
  });

  it('counts a stopped call apart from the fallbacks', async () => {
    const { api, daemon: d } = await start();
    seed(d, mix);
    const stats = await api.get('/judge/decisions', DecisionStatsListDto);
    expect(stats.decisions.find((s) => s.decision === 'review_size')).toMatchObject({
      calls: 4,
      acted: 2,
      stopped: 1,
      fallbacks: { off: 0, no_key: 0, timeout: 1, error: 0 },
    });
    expect(stats.decisions.find((s) => s.decision === 'shape_ready')).toMatchObject({
      belowFloor: 1,
    });
  });
});

describe('GET /judge/calls', () => {
  function seedCalls(d: RunningDaemon, count: number) {
    for (let i = 0; i < count; i += 1)
      d.state.write((ctx) => {
        insertJudgeCall(ctx, {
          decision: 'review_size',
          model: 'typesafe/jev-1.13',
          state: 'SECRET TASK TEXT',
          question: `q${String(i)}`,
          answer: 'skip',
          confidence: 0.9,
          outcome: 'acted',
          latencyMs: 100,
          costUsd: null,
          workstreamId: null,
          taskId: null,
        });
      });
  }

  it('lists the newest first, without the state sent', async () => {
    const { api, daemon: d } = await start();
    seedCalls(d, 3);
    const calls = await api.get('/judge/calls?limit=2', z.array(JudgeCallDto));
    expect(calls.map((c) => c.question)).toEqual(['q2', 'q1']);
    expect(JSON.stringify(calls)).not.toContain('SECRET TASK TEXT');
  });

  it.each([
    ['a limit over 100', '?limit=500', 100],
    ['a limit that is not a number', '?limit=many', 20],
    ['no limit', '', 20],
  ])('reads %s', async (_name, query, expected) => {
    const { api, daemon: d } = await start();
    seedCalls(d, 120);
    expect(await api.get(`/judge/calls${query}`, z.array(JudgeCallDto))).toHaveLength(expected);
  });

  it('logs a call the daemon made through the judge', async () => {
    const { api, daemon: d } = await start();
    await openRouterAccount(api);
    const answer = await d.judge.choose({
      decision: 'shape_ready',
      state: 's',
      question: 'Does this need a review?',
      options: ['review', 'skip'],
    });
    const calls = await api.get('/judge/calls', z.array(JudgeCallDto));
    expect(calls[0]).toMatchObject({ id: answer.callId, answer: 'skip', outcome: 'acted' });
  });
});

describe('the call log at startup', () => {
  it('deletes calls older than 30 days and keeps newer ones', async () => {
    const first = await start();
    const insert = (question: string) => {
      first.daemon.state.write((ctx) => {
        insertJudgeCall(ctx, {
          decision: 'review_size',
          model: 'm',
          state: 's',
          question,
          answer: null,
          confidence: null,
          outcome: 'fallback_off',
          latencyMs: null,
          costUsd: null,
          workstreamId: null,
          taskId: null,
        });
      });
    };
    insert('now');
    // Age one row past the retention by rewriting its time, as a daemon left running would have.
    insert('old');
    first.daemon.state.db.$client
      .prepare(
        `UPDATE judge_calls SET created_at = '2020-01-01T00:00:00.000Z' WHERE question = 'old'`,
      )
      .run();
    await first.daemon.stop();
    daemon = null;
    const { api } = await start();
    const calls = await api.get('/judge/calls', z.array(JudgeCallDto));
    expect(calls.map((c) => c.question)).toEqual(['now']);
  });
});
