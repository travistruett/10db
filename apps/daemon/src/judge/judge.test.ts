import { mintId, type AccountId } from '@10db/contracts';
import {
  createTestStore,
  listJudgeCalls,
  patchJudgeConfig,
  seedAccount,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createJudge, type JudgeRequest } from './index';

const KEY = 'router-test-key-0123';
const SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type Handler = (seen: Seen, signal: AbortSignal | undefined) => Promise<Response> | Response;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const systemOneBody = (probabilities: Record<string, number>, extra: object = {}) => {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ['review'];
  return {
    id: 'gen-dec-1',
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers: {
      decision: { type: 'choice', choice, confidence: 0.5, probabilities },
    },
    usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
    ...extra,
  };
};

const chatBody = (content: string, usage: object = { cost: 0.0004 }) => ({
  id: 'gen-1',
  model: 'anthropic/claude-haiku-5.5',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage,
});

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let seen: Seen[];
let handler: Handler;
let keyReads: number;
let keyAsked: (AccountId | null)[];
let key: string | null;
let keyError: Error | null;
let keyHangs: boolean;
/** OpenRouter's decision models as the judge's list reads them; null when the list can't be read. */
let decisionModels: ReadonlySet<string> | null;

function build(options: { off?: boolean } = {}) {
  return createJudge({
    state,
    clock,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const entry: Seen = {
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >,
      };
      seen.push(entry);
      return handler(entry, init?.signal ?? undefined);
    },
    readKey: (accountId) => {
      keyReads += 1;
      keyAsked.push(accountId);
      if (keyError) return Promise.reject(keyError);
      if (keyHangs) return new Promise<string | null>(() => undefined);
      return Promise.resolve(key);
    },
    decisionModelIds: () => decisionModels,
    off: options.off ?? false,
    logger: silentLogger,
  });
}

const request: JudgeRequest = {
  decision: 'shape_ready',
  state: 'Task: add a label. Diff: 3 lines.',
  question: 'Does this change need a review?',
  options: ['review', 'skip'],
};

const logged = () => listJudgeCalls(store.db, 10);

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  seen = [];
  keyReads = 0;
  keyAsked = [];
  key = KEY;
  keyError = null;
  keyHangs = false;
  decisionModels = new Set(['typesafe/jev-1.13', 'liquid/d1']);
  handler = () => json(systemOneBody({ review: 0.07, skip: 0.93 }));
});
afterEach(() => {
  close();
});

describe('judge.choose with a System One model', () => {
  it('asks the systemone endpoint a named choice question and answers with the chosen probability', async () => {
    handler = () => {
      clock.advance(250);
      return json(systemOneBody({ review: 0.07, skip: 0.93 }));
    };
    const answer = await build().choose({
      ...request,
      workstreamId: mintId('Workstream'),
      taskId: mintId('Task'),
    });
    expect(answer).toMatchObject({
      kind: 'answered',
      choice: 'skip',
      confidence: 0.93,
      model: 'typesafe/jev-1.13-20260917',
      latencyMs: 250,
      costUsd: 0.00003,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(SYSTEM_ONE_URL);
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body).toEqual({
      model: 'typesafe/jev-1.13',
      state: request.state,
      questions: {
        decision: {
          type: 'choice',
          instructions: request.question,
          criteria: { review: null, skip: null },
        },
      },
    });
  });

  it("sends an option's criteria as the choice criteria and logs them in the question", async () => {
    const criteria = { review: 'The diff touches shared code', skip: 'A rename in one file' };
    await build().choose({ ...request, criteria });
    expect(seen[0]?.body).toMatchObject({
      questions: { decision: { criteria } },
    });
    const [call] = logged();
    expect(call?.question).toBe(
      `${request.question}\nOptions:\n- review: The diff touches shared code\n- skip: A rename in one file`,
    );
  });

  it('logs the call with what was asked and the provisional outcome', async () => {
    const workstreamId = mintId('Workstream');
    const taskId = mintId('Task');
    const answer = await build().choose({ ...request, workstreamId, taskId });
    expect(logged()).toEqual([
      expect.objectContaining({
        id: answer.callId,
        decision: 'shape_ready',
        model: 'typesafe/jev-1.13',
        question: request.question,
        answer: 'skip',
        confidence: 0.93,
        outcome: 'acted',
        costUsd: 0.00003,
        workstreamId,
        taskId,
      }),
    ]);
  });

  it('logs an answer under the floor as below the floor', async () => {
    handler = () => json(systemOneBody({ review: 0.4, skip: 0.6 }));
    await build().choose(request);
    expect(logged()[0]).toMatchObject({ answer: 'skip', confidence: 0.6, outcome: 'below_floor' });
  });

  it('reads the key for each call and never keeps it', async () => {
    const judge = build();
    await judge.choose(request);
    await judge.choose(request);
    expect(keyReads).toBe(2);
  });
});

describe('judge.choose with another decision model', () => {
  beforeEach(() => {
    store.write((ctx) =>
      patchJudgeConfig(ctx, { decisions: { shape_ready: { model: 'liquid/d1' } } }),
    );
  });

  const decisionsBody = (answer: Record<string, unknown>) => ({
    id: 'gen-dec-2',
    model: 'liquid/d1',
    answers: { decision: { type: 'choice', ...answer } },
    usage: { input_tokens: 80, output_tokens: 1, cost: 0.000002 },
  });

  it('asks the decisions endpoint the System One question and answers with the chosen probability', async () => {
    handler = () =>
      json(decisionsBody({ choice: 'skip', probabilities: { review: 0.2, skip: 0.8 } }));
    expect(await build().choose(request)).toMatchObject({
      kind: 'answered',
      choice: 'skip',
      confidence: 0.8,
      model: 'liquid/d1',
      costUsd: 0.000002,
    });
    expect(seen.map((s) => s.url)).toEqual([DECISIONS_URL]);
    expect(seen[0]?.body).toEqual({
      model: 'liquid/d1',
      state: request.state,
      questions: {
        decision: {
          type: 'choice',
          instructions: request.question,
          // Some makers (Parallel, ScaleDown) refuse a null criterion: an option with none is described by its name.
          criteria: { review: 'review', skip: 'skip' },
        },
      },
    });
  });

  it('reads the confidence when the answer has no probabilities', async () => {
    handler = () => json(decisionsBody({ choice: 'review', confidence: 0.6 }));
    expect(await build().choose(request)).toMatchObject({ choice: 'review', confidence: 0.6 });
  });

  it('falls back on an answer with no confidence, which no floor can be checked against', async () => {
    handler = () => json(decisionsBody({ choice: 'skip' }));
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'error' });
    expect(answer.kind === 'fallback' && answer.detail).toMatch(/without a confidence/);
  });

  it.each([
    ['a decision model', 'liquid/d1', DECISIONS_URL],
    ['a model the list leaves out', 'anthropic/claude-haiku-5.5', CHAT_URL],
    ['a TypeSafe model the list leaves out', 'typesafe/jev-2', SYSTEM_ONE_URL],
  ])('sends %s to its endpoint', async (_name, model, url) => {
    store.write((ctx) => patchJudgeConfig(ctx, { decisions: { shape_ready: { model } } }));
    await build().choose(request);
    expect(seen.map((s) => s.url)).toEqual([url]);
  });

  it('takes a model to be a decision model when the list cannot be read', async () => {
    decisionModels = null;
    store.write((ctx) =>
      patchJudgeConfig(ctx, {
        decisions: { shape_ready: { model: 'anthropic/claude-haiku-5.5' } },
      }),
    );
    await build().choose(request);
    expect(seen.map((s) => s.url)).toEqual([DECISIONS_URL]);
  });
});

describe('judge.choose with a chat model', () => {
  beforeEach(() => {
    store.write((ctx) =>
      patchJudgeConfig(ctx, {
        decisions: { shape_ready: { model: 'anthropic/claude-haiku-5.5' } },
      }),
    );
  });

  it("puts an option's criteria in the prompt", async () => {
    handler = () => json(chatBody('{"choice":"skip","confidence":0.9}'));
    await build().choose({
      ...request,
      criteria: { review: 'The diff touches shared code', skip: 'A rename in one file' },
    });
    const messages = (seen[0]?.body['messages'] ?? []) as { content: string }[];
    expect(messages[1]?.content).toContain('- review: The diff touches shared code');
    expect(messages[1]?.content).toContain('- skip: A rename in one file');
  });

  it('asks chat completions for a JSON-schema answer', async () => {
    handler = () => json(chatBody('{"choice":"skip","confidence":0.88}'));
    const answer = await build().choose(request);
    expect(answer).toMatchObject({
      kind: 'answered',
      choice: 'skip',
      confidence: 0.88,
      model: 'anthropic/claude-haiku-5.5',
      costUsd: 0.0004,
    });
    const body = seen[0]?.body;
    expect(seen[0]?.url).toBe(CHAT_URL);
    expect(body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      response_format: {
        type: 'json_schema',
        json_schema: {
          strict: true,
          schema: { properties: { choice: { enum: ['review', 'skip'] } } },
        },
      },
    });
    expect(JSON.stringify(body)).toContain(request.state);
    expect(JSON.stringify(body)).toContain(request.question);
  });

  it('reads a missing cost as null', async () => {
    handler = () => json(chatBody('{"choice":"review","confidence":0.5}', {}));
    expect(await build().choose(request)).toMatchObject({ kind: 'answered', costUsd: null });
  });
});

describe('judge.off', () => {
  it.each([true, false])('is %s when the daemon was started that way', (off) => {
    expect(build({ off }).off).toBe(off);
  });
});

describe('judge.choose falls back', () => {
  it('is off when the daemon is, without reading the key or calling out', async () => {
    const answer = await build({ off: true }).choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'off' });
    expect(keyReads).toBe(0);
    expect(seen).toEqual([]);
    expect(logged()[0]).toMatchObject({ outcome: 'fallback_off', answer: null, confidence: null });
  });

  it.each([
    ['the master switch is off', { enabled: false }],
    ['the decision is off', { decisions: { shape_ready: { enabled: false } } }],
  ])('is off when %s', async (_name, patch) => {
    store.write((ctx) => patchJudgeConfig(ctx, patch));
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'off' });
    expect(keyReads).toBe(0);
    expect(seen).toEqual([]);
  });

  it('has no key', async () => {
    key = null;
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'no_key' });
    expect(seen).toEqual([]);
    expect(logged()[0]?.outcome).toBe('fallback_no_key');
  });

  it('cannot read the key', async () => {
    keyError = new Error('Reading the Keychain failed (security exit status 36)');
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'error' });
    expect(answer.kind === 'fallback' && answer.detail).toContain('status 36');
    expect(seen).toEqual([]);
  });

  it.each([
    ['an HTTP 401', () => json({ error: { message: 'No auth credentials found' } }, 401), /401/],
    ['an HTTP 500', () => json({ error: { message: 'down' } }, 500), /500/],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), /JSON/i],
    ['a body of the wrong shape', () => json({ model: 'm', answers: {} }), /answer/i],
    [
      'an answer of another type',
      () => json({ model: 'm', answers: { decision: { type: 'noul', noul: 0.9 } }, usage: {} }),
      /answer/i,
    ],
    [
      'a choice that was not offered',
      () => json(systemOneBody({ maybe: 0.9, review: 0.1 })),
      /maybe/,
    ],
    ['a probability above one', () => json(systemOneBody({ review: 0.1, skip: 1.4 })), /answer/i],
    ['a probability below zero', () => json(systemOneBody({ review: -0.3, skip: 0.9 })), /answer/i],
    [
      'a request that fails',
      () => {
        throw new TypeError('fetch failed');
      },
      /fetch failed/,
    ],
  ])('turns %s into an error', async (_name, respond, detail) => {
    handler = respond;
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'error' });
    expect(answer.kind === 'fallback' && answer.detail).toMatch(detail);
    expect(logged()[0]).toMatchObject({ outcome: 'fallback_error', answer: null });
  });

  it.each([
    ['content that is not JSON', 'sure, skip it'],
    ['JSON of the wrong shape', '{"choice":"skip"}'],
    ['a confidence above one', '{"choice":"skip","confidence":7}'],
    ['a choice that was not offered', '{"choice":"maybe","confidence":0.9}'],
  ])('turns a chat answer with %s into an error', async (_name, content) => {
    store.write((ctx) =>
      patchJudgeConfig(ctx, { decisions: { shape_ready: { model: 'openai/gpt-5-nano' } } }),
    );
    handler = () => json(chatBody(content));
    expect(await build().choose(request)).toMatchObject({ kind: 'fallback', reason: 'error' });
  });

  it('times out after four seconds on the injected clock', async () => {
    handler = (_seen, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = build().choose(request);
    await Promise.resolve();
    clock.advance(3_999);
    clock.advance(1);
    const answer = await pending;
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'timeout' });
    expect(logged()[0]).toMatchObject({ outcome: 'fallback_timeout', latencyMs: 4000 });
  });

  it('counts a key read that never answers in the four seconds', async () => {
    keyHangs = true;
    const pending = build().choose(request);
    clock.advance(4_000);
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'timeout' });
    expect(seen).toEqual([]);
    expect(logged()[0]).toMatchObject({ outcome: 'fallback_timeout' });
    expect(clock.pendingTimers()).toBe(0);
  });

  it('stops waiting for the key when the caller aborts', async () => {
    keyHangs = true;
    const controller = new AbortController();
    const pending = build().choose({ ...request, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'stopped' });
    expect(seen).toEqual([]);
    expect(logged()[0]).toMatchObject({ outcome: 'stopped' });
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    handler = (_seen, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = build().choose({ ...request, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'stopped' });
    expect(logged()[0]).toMatchObject({ outcome: 'stopped' });
  });

  it('logs a call whose signal was already aborted as stopped, not as an error', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await build().choose({ ...request, signal: controller.signal })).toMatchObject({
      kind: 'fallback',
      reason: 'stopped',
    });
    expect(seen).toEqual([]);
    expect(logged()[0]).toMatchObject({ outcome: 'stopped' });
  });

  it('still logs a timeout as a timeout when a signal was passed and not aborted', async () => {
    const controller = new AbortController();
    handler = (_seen, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const pending = build().choose({ ...request, signal: controller.signal });
    await Promise.resolve();
    clock.advance(4_000);
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'timeout' });
  });

  it('cancels its timer when the call finishes', async () => {
    await build().choose(request);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('does not act on a call it cannot log, and does not throw', async () => {
    state = {
      db: state.db,
      now: () => state.now(),
      write: () => {
        throw new Error('disk full');
      },
    };
    const answer = await build().choose(request);
    expect(answer).toMatchObject({ kind: 'fallback', reason: 'error' });
    expect(answer.kind === 'fallback' && answer.detail).toContain('disk full');
  });
});

describe('the key never leaves the judge', () => {
  it('is scrubbed from an error body that echoes it, in the answer and the log', async () => {
    handler = () => json({ error: { message: `Invalid key ${KEY}` } }, 401);
    const answer = await build().choose(request);
    const everything = JSON.stringify([answer, listJudgeCalls(store.db, 10)]);
    expect(everything).not.toContain(KEY);
    expect(answer.kind === 'fallback' && answer.detail).toContain('401');
  });

  it('is not in the stored state, question or config', async () => {
    await build().choose(request);
    const rows = store.db.$client.prepare('SELECT * FROM judge_calls').all();
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });
});

describe('the account a decision reads its key from', () => {
  it('asks for the key of the account decisions run on, and for none when no account is picked', async () => {
    await build().choose(request);
    expect(keyAsked).toEqual([null]);
    const account = seedAccount(store, { kind: 'openrouter', label: 'OpenRouter' });
    store.write((ctx) => patchJudgeConfig(ctx, { accountId: account.id }));
    await build().choose(request);
    expect(keyAsked).toEqual([null, account.id]);
  });

  it('tests the account it is given, not the one decisions run on', async () => {
    const other = mintId('Account');
    expect((await build().test(other)).ok).toBe(true);
    expect(keyAsked).toEqual([other]);
  });
});

describe('judge.test', () => {
  it('reports the model, latency and cost of a tiny call, and logs nothing', async () => {
    handler = () => {
      clock.advance(180);
      return json(systemOneBody({ review: 0.1, skip: 0.9 }));
    };
    expect(await build().test(mintId('Account'))).toEqual({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      latencyMs: 180,
      costUsd: 0.00003,
    });
    expect(logged()).toEqual([]);
  });

  it.each([
    ['the daemon is off', () => build({ off: true }), /TENDB_JUDGE=off/],
    [
      'there is no key',
      () => {
        key = null;
        return build();
      },
      /key/i,
    ],
  ])('says why when %s', async (_name, make, error) => {
    const result = await make().test(mintId('Account'));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(error);
    expect(seen).toEqual([]);
  });

  it('says what OpenRouter answered when the call fails', async () => {
    handler = () => json({ error: { message: 'No auth credentials found' } }, 401);
    const result = await build().test(mintId('Account'));
    expect(!result.ok && result.error).toMatch(/401/);
  });

  it('tests the model it is given instead of the review model', async () => {
    handler = () =>
      json({
        model: 'liquid/d1',
        answers: { decision: { type: 'choice', choice: 'review', confidence: 0.7 } },
        usage: {},
      });
    expect(await build().test(mintId('Account'), 'liquid/d1')).toMatchObject({
      ok: true,
      model: 'liquid/d1',
    });
    expect(seen.map((s) => [s.url, s.body['model']])).toEqual([[DECISIONS_URL, 'liquid/d1']]);
  });

  it('still tests with the decision switched off', async () => {
    store.write((ctx) => patchJudgeConfig(ctx, { decisions: { shape_ready: { enabled: false } } }));
    expect((await build().test(mintId('Account'))).ok).toBe(true);
  });
});
