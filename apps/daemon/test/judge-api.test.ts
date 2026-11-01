import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeStatusDto,
  JudgeTestResultDto,
} from '@10db/contracts';
import { insertJudgeCall } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { KeychainError, OPENROUTER_KEY_ACCOUNT, type Keychain } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, tempDir } from './fixtures';

const KEY = 'sk-or-v1-0123456789abcdef-NEVER-SHOWN';
const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let openRouterRequests: { url: string; authorization: string | null }[];
let openRouterAnswer: () => Response;

beforeEach(() => {
  data = tempDir('judge api');
  daemon = null;
  openRouterRequests = [];
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
  daemon = await startDaemon({
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
      return Promise.resolve(openRouterAnswer());
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
      keySet: false,
      off: false,
    });
  });

  it('is refused without the UI token', async () => {
    const { daemon: d } = await start();
    expect((await fetch(`${d.url}/judge`)).status).toBe(401);
  });

  it('reads the key without blocking: the synchronous read is never used', async () => {
    const memory = createMemoryKeychain({ [OPENROUTER_KEY_ACCOUNT]: KEY });
    const { api } = await start({
      keychain: {
        ...memory,
        read: () => {
          throw new Error('the synchronous read blocks the event loop');
        },
      },
    });
    expect(await api.get('/judge', JudgeStatusDto)).toMatchObject({ keySet: true });
  });

  it('reports a daemon started with the judge off, without reading the key', async () => {
    let reads = 0;
    const memory = createMemoryKeychain({ [OPENROUTER_KEY_ACCOUNT]: KEY });
    const { api } = await start({
      judgeOff: true,
      keychain: {
        ...memory,
        read: (account) => {
          reads += 1;
          return memory.read(account);
        },
        readAsync: (account) => {
          reads += 1;
          return memory.readAsync(account);
        },
      },
    });
    expect(await api.get('/judge', JudgeStatusDto)).toMatchObject({ keySet: false, off: true });
    expect(reads).toBe(0);
  });
});

describe('PATCH /judge', () => {
  it('merges a patch and answers the status', async () => {
    const { api } = await start();
    const status = await api.patch('/judge', JudgeStatusDto, {
      enabled: false,
      decisions: { review_size: { floor: 0.95, model: 'anthropic/claude-haiku-5.5' } },
    });
    expect(status.config).toEqual({
      enabled: false,
      decisions: {
        review_size: { enabled: true, model: 'anthropic/claude-haiku-5.5', floor: 0.95 },
      },
    });
    expect(await api.get('/judge', JudgeStatusDto)).toEqual(status);
  });

  it.each([
    ['a floor above one', { decisions: { review_size: { floor: 3 } } }],
    ['an unknown decision', { decisions: { other: { enabled: true } } }],
    ['an empty model', { decisions: { review_size: { model: '' } } }],
  ])('answers 400 for %s and changes nothing', async (_name, body) => {
    const { api, raw } = await start();
    expect((await raw('PATCH', '/judge', body)).status).toBe(400);
    expect((await api.get('/judge', JudgeStatusDto)).config).toEqual(DEFAULT_JUDGE_CONFIG);
  });
});

describe('the OpenRouter key', () => {
  it('goes to the Keychain, shows as set, and is removed again', async () => {
    const { api, raw, keychain } = await start();
    const set = await api.put('/judge/key', JudgeStatusDto, { key: `  ${KEY}  ` });
    expect(set.keySet).toBe(true);
    expect(keychain.read(OPENROUTER_KEY_ACCOUNT)).toBe(KEY);
    const removed = await raw('DELETE', '/judge/key');
    expect(removed.status).toBe(200);
    expect(JudgeStatusDto.parse(await removed.json()).keySet).toBe(false);
    expect(keychain.read(OPENROUTER_KEY_ACCOUNT)).toBeNull();
  });

  it('removing a key that is not set is not an error', async () => {
    const { raw } = await start();
    expect((await raw('DELETE', '/judge/key')).status).toBe(200);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['with a space inside', 'sk or'],
    ['with a quote', 'sk"or'],
  ])('answers 400 for a key that is %s', async (_name, key) => {
    const { raw, keychain } = await start();
    expect((await raw('PUT', '/judge/key', { key })).status).toBe(400);
    expect(keychain.read(OPENROUTER_KEY_ACCOUNT)).toBeNull();
  });

  it('answers 409 when the Keychain refuses, naming no key', async () => {
    const memory = createMemoryKeychain();
    const { raw } = await start({
      keychain: {
        ...memory,
        write: (account) => {
          throw new KeychainError(`Writing the Keychain item ${account} failed (status 36)`);
        },
      },
    });
    const res = await raw('PUT', '/judge/key', { key: KEY });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('NEVER-SHOWN');
  });

  it('is never in a response, the event stream, the database or the log', async () => {
    const { api, raw, daemon: d } = await start();
    const seen: string[] = [];
    seen.push(JSON.stringify(await api.put('/judge/key', z.unknown(), { key: KEY })));
    seen.push(JSON.stringify(await api.get('/judge', z.unknown())));
    seen.push(JSON.stringify(await api.patch('/judge', z.unknown(), { enabled: true })));
    seen.push(JSON.stringify(await api.post('/judge/test', z.unknown())));
    seen.push(JSON.stringify(await api.get('/judge/calls', z.unknown())));
    seen.push(JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown())));
    seen.push(await (await raw('DELETE', '/judge/key')).text());
    // A rejected key echoed back by the server must not reach the response either.
    openRouterAnswer = () =>
      Response.json({ error: { message: `Invalid key ${KEY}` } }, { status: 401 });
    await api.put('/judge/key', z.unknown(), { key: KEY });
    seen.push(JSON.stringify(await api.post('/judge/test', z.unknown())));
    for (const text of seen) expect(text).not.toContain('NEVER-SHOWN');
    await d.stop();
    const files = ['logs/daemon.log', '10db.sqlite', '10db.sqlite-wal'].map((name) =>
      join(data.path, name),
    );
    for (const file of files.filter(existsSync))
      expect(readFileSync(file).includes(KEY), file).toBe(false);
  });
});

describe('POST /judge/test', () => {
  it('calls the review model with the stored key and answers model, latency and cost', async () => {
    const { api } = await start();
    await api.put('/judge/key', JudgeStatusDto, { key: KEY });
    const result = JudgeTestResultDto.parse(await api.post('/judge/test', z.unknown()));
    expect(result).toMatchObject({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      costUsd: 0.00001,
    });
    expect(openRouterRequests).toEqual([
      { url: 'https://openrouter.ai/api/v1/systemone', authorization: `Bearer ${KEY}` },
    ]);
  });

  it('says there is no key, and makes no request', async () => {
    const { api } = await start();
    const result = JudgeTestResultDto.parse(await api.post('/judge/test', z.unknown()));
    expect(result).toEqual({ ok: false, error: 'No OpenRouter key is set' });
    expect(openRouterRequests).toEqual([]);
  });

  it('says why OpenRouter refused, in plain words', async () => {
    openRouterAnswer = () =>
      Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 });
    const { api } = await start();
    await api.put('/judge/key', JudgeStatusDto, { key: KEY });
    const result = JudgeTestResultDto.parse(await api.post('/judge/test', z.unknown()));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('401');
  });

  it('with the judge off, says so and makes no request', async () => {
    const { api } = await start({
      judgeOff: true,
      keychain: createMemoryKeychain({ [OPENROUTER_KEY_ACCOUNT]: KEY }),
    });
    const result = JudgeTestResultDto.parse(await api.post('/judge/test', z.unknown()));
    expect(!result.ok && result.error).toContain('TENDB_JUDGE=off');
    expect(openRouterRequests).toEqual([]);
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
    await api.put('/judge/key', JudgeStatusDto, { key: KEY });
    const answer = await d.judge.choose({
      decision: 'review_size',
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
