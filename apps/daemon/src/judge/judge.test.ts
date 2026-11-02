import { mintId } from '@10db/contracts';
import { createTestStore, listJudgeCalls, patchJudgeConfig, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createJudge, type JudgeRequest } from './index';

const KEY = 'router-test-key-0123';
const SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
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
let key: string | null;
let keyError: Error | null;
let keyHangs: boolean;

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
    readKey: () => {
      keyReads += 1;
      if (keyError) return Promise.reject(keyError);
      if (keyHangs) return new Promise<string | null>(() => undefined);
      return Promise.resolve(key);
    },
    off: options.off ?? false,
    logger: silentLogger,
  });
}

const request: JudgeRequest = {
  decision: 'review_size',
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
  key = KEY;
  keyError = null;
  keyHangs = false;
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

  it('logs the call with what was asked and the provisional outcome', async () => {
    const workstreamId = mintId('Workstream');
    const taskId = mintId('Task');
    const answer = await build().choose({ ...request, workstreamId, taskId });
    expect(logged()).toEqual([
      expect.objectContaining({
        id: answer.callId,
        decision: 'review_size',
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

describe('judge.choose with a chat model', () => {
  beforeEach(() => {
    store.write((ctx) =>
      patchJudgeConfig(ctx, {
        decisions: { review_size: { model: 'anthropic/claude-haiku-5.5' } },
      }),
    );
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
    ['the decision is off', { decisions: { review_size: { enabled: false } } }],
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
      patchJudgeConfig(ctx, { decisions: { review_size: { model: 'openai/gpt-5-nano' } } }),
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

describe('judge.test', () => {
  it('reports the model, latency and cost of a tiny call, and logs nothing', async () => {
    handler = () => {
      clock.advance(180);
      return json(systemOneBody({ review: 0.1, skip: 0.9 }));
    };
    expect(await build().test()).toEqual({
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
    const result = await make().test();
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(error);
    expect(seen).toEqual([]);
  });

  it('says what OpenRouter answered when the call fails', async () => {
    handler = () => json({ error: { message: 'No auth credentials found' } }, 401);
    const result = await build().test();
    expect(!result.ok && result.error).toMatch(/401/);
  });

  it('still tests with the decision switched off', async () => {
    store.write((ctx) => patchJudgeConfig(ctx, { decisions: { review_size: { enabled: false } } }));
    expect((await build().test()).ok).toBe(true);
  });
});
