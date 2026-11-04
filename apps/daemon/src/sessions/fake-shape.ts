import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createChannel } from './channel';
import type {
  SessionEvent,
  ShapeImage,
  ShapeSessionHandle,
  ShapeSessionSpec,
  ShapeToolRequest,
  ShapeVerdict,
} from './types';

/** What a scripted turn of a fake Shape session did. */
export interface FakeShapeTurnResult {
  /** What the model wrote last. */
  readonly text?: string;
  /** The share of the context window in use after the turn; 10 when absent. */
  readonly contextPercent?: number;
}

/** One turn the fake runs for a message it was sent. */
export interface FakeShapeTurn {
  readonly spec: ShapeSessionSpec;
  /** The message the turn answers. */
  readonly message: string;
  /** The images sent with it, as image content blocks. */
  readonly images: readonly ShapeImage[];
  /** Which message of this session it is, from 1. */
  readonly number: number;
  /** Aborts when the turn is interrupted. */
  readonly signal: AbortSignal;
  /** The session's PreToolUse hook, as Claude Code runs it before each call. */
  guard(request: ShapeToolRequest): ShapeVerdict;
}

export type FakeShapeBehaviour = (turn: FakeShapeTurn) => Promise<FakeShapeTurnResult>;

const DEFAULT_CONTEXT_PERCENT = 10;

const BUILDER_MESSAGE_ID = /\[m:([^\]]+)\]/;
const MAX_HEARD_ITEMS = 5;
const MAX_HEARD_CHARS = 80;
/** What the project's areas are, when a draft names one it hasn't got: "(it has src, ui)". */
const AREAS_OF_THE_PROJECT = /\(it has ([^)]+)\)/;

/** "see the board", "see the task tsk_…", each with an optional "at 900": a look at one of the app's screens. */
const SEE_SCREEN = /\bsee the (factory|board|inbox|plan|task (\S+))(?: at (\d+))?/i;

/** What the scripted draft proposes, citing the builder's messages; every task is in `area`. */
function scriptedDraft(area: string, sources: readonly string[]): Record<string, unknown> {
  const task = (key: string, title: string) => ({
    key,
    title,
    criteria: [`${title} is done`],
    areas: [area],
    size: 'S',
  });
  return {
    goals: [
      {
        key: 'board-polish',
        title: 'Board polish',
        objective: 'The board is denser and calmer to scan.',
        ceremony: 'direct',
        criteria: [],
        sourceMessageIds: sources,
        tasks: [task('density', 'Compact card density'), task('scrollbars', 'Thin scrollbars')],
      },
    ],
    looseTasks: [
      {
        ...task('abandon-strip', 'Drop the Abandon strip'),
        ceremony: 'direct',
        sourceMessageIds: sources,
      },
      {
        ...task('failed-label', 'Say "failed" in plain words'),
        ceremony: 'direct',
        sourceMessageIds: sources,
      },
    ],
    records: [
      {
        key: 'plain-words',
        kind: 'decision',
        scope: 'project',
        question: 'How does a failure read?',
        choice: 'In plain words, with what Retry will do',
        rationale: 'The builder acts on a sentence, not a status.',
        sourceMessageIds: sources,
      },
    ],
  };
}

/**
 * A Shape session that answers like a small, deterministic Claude, for the e2e and for a daemon on the
 * fake adapter: it echoes what it heard with `note_heard` and replies; on a Propose it states a plan
 * (one goal with two tasks, two loose tasks, one decision) through `propose_plan`, in the project's
 * first area, learning the area from the refusal when the draft's first guess is wrong.
 */
export function scriptedShapeBehaviour(): FakeShapeBehaviour {
  /** The builder's message ids each conversation has seen, as a proposal may cite them. */
  const heard = new Map<string, string[]>();
  return async (turn) => {
    const client = new Client({ name: 'fake-claude', version: '0.0.0' });
    const call = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string; images: number }> => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: turn.spec.mcp.toolTimeoutMs,
        signal: turn.signal,
      });
      const content = (Array.isArray(result.content) ? result.content : []) as {
        type?: string;
        text?: string;
      }[];
      const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      return {
        isError: result.isError === true,
        text,
        images: content.filter((c) => c.type === 'image').length,
      };
    };
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(turn.spec.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${turn.spec.mcp.token}` } },
        }),
      );
      const ids = heard.get(turn.spec.shapeId) ?? [];
      heard.set(turn.spec.shapeId, ids);
      if (turn.message.includes('pressed Propose')) {
        if (ids.length === 0) return { text: 'There is nothing to propose from yet.' };
        let area = 'repo';
        let answer = await call('propose_plan', { draft: scriptedDraft(area, ids) });
        const names = AREAS_OF_THE_PROJECT.exec(answer.text)?.[1];
        const first = names?.split(',')[0]?.trim();
        if (answer.isError && first !== undefined && first !== '') {
          area = first;
          answer = await call('propose_plan', { draft: scriptedDraft(area, ids) });
        }
        return { text: answer.isError ? 'I could not state a plan.' : 'Here is the plan.' };
      }
      const id = BUILDER_MESSAGE_ID.exec(turn.message)?.[1];
      if (id !== undefined) ids.push(id);
      const text = turn.message.replace(BUILDER_MESSAGE_ID, '');
      // "See the board at 900" asks for a screen, as a session planning UI work would.
      const look = SEE_SCREEN.exec(text);
      if (look !== null) {
        const screen = (look[1] ?? '').toLowerCase();
        const taskId = look[2];
        const answer = await call('see_screen', {
          screen: taskId === undefined ? screen : 'task',
          ...(taskId === undefined ? {} : { taskId }),
          ...(look[3] === undefined ? {} : { width: Number(look[3]) }),
        });
        return {
          text: answer.isError
            ? `I could not see it: ${answer.text}`
            : `I saw the ${screen}: ${String(answer.images)} picture.`,
        };
      }
      const items = text
        .split(/[\n.]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .slice(0, MAX_HEARD_ITEMS)
        .map((s) => s.slice(0, MAX_HEARD_CHARS));
      await call('note_heard', { items });
      return { text: `Noted ${String(items.length)} ${items.length === 1 ? 'thing' : 'things'}.` };
    } finally {
      await client.close();
    }
  };
}

/** A Shape session that ends at once with the account's refusal, before any message. */
export function refusedShapeSession(message: string): ShapeSessionHandle {
  const events = createChannel<SessionEvent>();
  events.push({
    type: 'ended',
    reason: 'account_refused',
    message: `${message}. No message was sent.`,
  });
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

/**
 * Stands in for a Shape conversation's Claude Code session: each message it is sent runs the
 * scripted behaviour as one turn, and the turns run one after another.
 */
export function createFakeShapeSession(
  spec: ShapeSessionSpec,
  behaviour: FakeShapeBehaviour,
  providerSessionId: string,
): ShapeSessionHandle {
  const events = createChannel<SessionEvent>();
  const queue: { text: string; images: readonly ShapeImage[] }[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let current: AbortController | null = null;
  let number = 0;
  // Read through a function: TypeScript would otherwise keep the narrowing from before the awaits.
  const isEnded = (): boolean => ended;
  const finish = (reason: 'stopped' | 'error', message: string | null): void => {
    if (ended) return;
    ended = true;
    events.push({ type: 'ended', reason, message });
    events.end();
    wake?.();
  };

  const guard = (request: ShapeToolRequest): ShapeVerdict => {
    try {
      return spec.preToolUse(request);
    } catch (error) {
      return { decision: 'deny', reason: `guard failed: ${String(error)}` };
    }
  };

  const loop = async (): Promise<void> => {
    events.push({ type: 'started', providerSessionId, pid: null });
    queue.push({ text: spec.prompt, images: spec.images ?? [] });
    while (!isEnded()) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      number += 1;
      current = new AbortController();
      let result: FakeShapeTurnResult = {};
      let failed = false;
      try {
        result = await behaviour({
          spec,
          message: next.text,
          images: next.images,
          number,
          signal: current.signal,
          guard,
        });
      } catch (error) {
        if (!current.signal.aborted) {
          failed = true;
          events.push({ type: 'activity', kind: 'text', summary: String(error) });
        }
      }
      current = null;
      if (isEnded()) break;
      const percent = result.contextPercent ?? DEFAULT_CONTEXT_PERCENT;
      events.push({
        type: 'context',
        percentage: percent,
        totalTokens: percent * 2_000,
        maxTokens: 200_000,
      });
      events.push({
        type: 'turn_complete',
        ...(failed ? { result: 'error' as const } : {}),
        ...(result.text === undefined ? {} : { text: result.text }),
        inputTokens: 100 * number,
        outputTokens: 10 * number,
        cachedTokens: 0,
        costUsd: 0,
      });
    }
  };
  void loop();

  return {
    events,
    send(text, images = []) {
      queue.push({ text, images });
      wake?.();
    },
    interrupt() {
      current?.abort();
      return Promise.resolve();
    },
    stop() {
      current?.abort();
      finish('stopped', null);
      return Promise.resolve();
    },
  };
}
