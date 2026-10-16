// Shared query plumbing: the options every probe uses, a message pump that asserts subscription billing and
// records rate-limit events, and a streaming conversation for multi-turn probes.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  query,
  type AccountInfo,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE } from './claude.ts';
import { buildChildEnv } from './env.ts';
import { info, outPath } from './report.ts';

export type Run = {
  messages: SDKMessage[];
  init?: SDKSystemMessage;
  result?: SDKResultMessage;
  account?: AccountInfo;
  error?: unknown;
};

const SPIKE = basename(process.argv[1] ?? 'unknown', '.ts');

export const PROBE_TIMEOUT_MS = 180_000;
export const TURN_TIMEOUT_MS = 120_000;
const ACCOUNT_TIMEOUT_MS = 10_000;

/** Aborts `controller` after `ms`; a caller's own controller is chained, not replaced. */
function withTimeout(controller: AbortController, ms: number): AbortController {
  const timer = setTimeout(() => controller.abort(new Error(`TIMEOUT: probe exceeded ${ms} ms`)), ms);
  timer.unref();
  return controller;
}

export function baseOptions(cwd: string, extra: Partial<Options> = {}, timeoutMs = PROBE_TIMEOUT_MS): Options {
  return {
    cwd,
    pathToClaudeCodeExecutable: CLAUDE.path,
    env: buildChildEnv(),
    settingSources: ['project'],
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    model: 'haiku',
    effort: 'low',
    maxTurns: 6,
    maxBudgetUsd: 0.5,
    persistSession: true,
    stderr: (data) => appendFileSync(outPath(`${SPIKE}.stderr.log`), data),
    ...extra,
    abortController: withTimeout(extra.abortController ?? new AbortController(), timeoutMs),
  };
}

/**
 * Allowlist: the subscription login reports apiKeySource 'none', apiProvider 'firstParty' and a subscription type.
 * 'none' alone is not enough (Bedrock reports it too), and firstParty alone is not enough (a Console API key
 * reports it as '/login managed key').
 */
export function assertSubscription(init: Pick<SDKSystemMessage, 'apiKeySource'> | undefined, account: AccountInfo | undefined): void {
  const provider = account?.apiProvider ?? 'unknown';
  const keySource = init?.apiKeySource ?? 'unknown';
  const subscriptionType = account?.subscriptionType ?? '';
  info('auth', { provider, apiKeySource: keySource, subscriptionType: subscriptionType || 'unknown', tokenSource: account?.tokenSource ?? 'unknown' });
  if (keySource !== 'none') throw new Error(`BILLING: apiKeySource is ${keySource}, expected none (the subscription login)`);
  if (provider !== 'firstParty') throw new Error(`BILLING: provider is ${provider}, expected firstParty`);
  if (subscriptionType === '') throw new Error('BILLING: no subscriptionType; this is not a claude.ai subscription login');
}

function accountWithin(q: Query, ms: number): Promise<AccountInfo | undefined> {
  return Promise.race([
    q.accountInfo().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref()),
  ]);
}

function record(m: SDKMessage): void {
  if (m.type === 'rate_limit_event') {
    const row = { recordedAt: Date.now(), spike: SPIKE, info: m.rate_limit_info };
    appendFileSync(outPath('rate-limit-events.jsonl'), `${JSON.stringify(row)}\n`);
  }
  if (m.type === 'assistant' && m.error !== undefined) {
    appendFileSync(outPath('assistant-errors.jsonl'), `${JSON.stringify({ recordedAt: Date.now(), spike: SPIKE, error: m.error })}\n`);
  }
}

export async function drive(q: Query, onMessage?: (m: SDKMessage) => void | Promise<void>): Promise<Run> {
  const run: Run = { messages: [] };
  const accountP = accountWithin(q, ACCOUNT_TIMEOUT_MS);
  try {
    for await (const m of q) {
      run.messages.push(m);
      record(m);
      if (m.type === 'system' && m.subtype === 'init') {
        run.init = m;
        run.account = await accountP;
        assertSubscription(run.init, run.account);
      }
      if (m.type === 'result') {
        run.result = m;
        info('cost', { total_cost_usd: m.total_cost_usd, subtype: m.subtype, num_turns: m.num_turns });
      }
      await onMessage?.(m);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BILLING')) throw error;
    run.error = error;
  }
  return run;
}

export function runOnce(prompt: string, options: Options, onMessage?: (m: SDKMessage) => void | Promise<void>): Promise<Run> {
  return drive(query({ prompt, options }), onMessage);
}

/** A pushable prompt stream; the query stays open between turns. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(text: string): void {
    this.#items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }
}

export type Conversation = { q: Query; send(text: string): Promise<Run>; close(): Promise<Run> };

type Pending = { run: Run; resolve: (r: Run) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };

/**
 * A multi-turn session. `send` always settles: with the turn's result, or with `error` set if the stream ends or
 * the turn times out first (a `/compact` with no result, a hook that stops the session). A BILLING failure
 * rejects `send` and `close`, and is never left as an unhandled rejection.
 */
export function openConversation(
  options: Options,
  opts: { turnTimeoutMs?: number; onMessage?: (m: SDKMessage) => void } = {},
): Conversation {
  const turnTimeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const input = new InputQueue();
  const q = query({ prompt: input, options });
  let turn: Pending | undefined;
  let fatal: unknown;
  let ended = false;
  const take = (): Pending | undefined => {
    const t = turn;
    turn = undefined;
    if (t) clearTimeout(t.timer);
    return t;
  };
  const all = drive(q, (m) => {
    opts.onMessage?.(m);
    if (!turn) return;
    turn.run.messages.push(m);
    if (m.type === 'result') {
      const t = take();
      if (t) {
        t.run.result = m;
        t.resolve(t.run);
      }
    }
  });
  all.then(
    (run) => {
      ended = true;
      const t = take();
      if (t) t.resolve({ ...t.run, error: run.error ?? new Error('the stream ended before the turn produced a result') });
    },
    (error: unknown) => {
      ended = true;
      fatal = error;
      take()?.reject(error);
    },
  );
  return {
    q,
    send(text) {
      if (fatal !== undefined) return Promise.reject(fatal);
      if (ended) return Promise.resolve({ messages: [], error: new Error('the conversation has already ended') });
      return new Promise<Run>((resolve, reject) => {
        const pending: Pending = {
          run: { messages: [] },
          resolve,
          reject,
          timer: setTimeout(() => {
            if (turn !== pending) return;
            turn = undefined;
            resolve({ ...pending.run, error: new Error(`TIMEOUT: no result within ${turnTimeoutMs} ms`) });
          }, turnTimeoutMs),
        };
        turn = pending;
        input.push(text);
      });
    },
    async close() {
      input.close();
      return all;
    },
  };
}

/** The text of a successful result, or an empty string. */
export function resultText(run: Run): string {
  return run.result?.subtype === 'success' ? run.result.result : '';
}
