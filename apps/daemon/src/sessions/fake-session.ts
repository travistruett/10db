import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AccountProblem, type AccountRefusal, type ModelMarkBasis } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { matchesAllowedTool } from '../permissions';
import type { ReportedMode } from '../trust';
import { credentialProblem, modelMatches } from './account-check';
import { createChannel } from './channel';
import {
  TURN_STEPS,
  type FakeInterrupt,
  type FakeObservation,
  type FakeSent,
  type FakeStep,
} from './fake-script';
import { claudeToolTarget } from './tool-target';
import {
  SessionEndReason,
  type InterruptReceipt,
  type SessionEvent,
  type SessionHandle,
  type LaneSessionSpec,
  type ShapeImage,
  type AgentSessionSpec,
  type ExploreSessionSpec,
  type ShapeToolRequest,
  type ShapeVerdict,
  type ToolDecision,
} from './types';

/** One fake session's event stream and its single end, which both drivers run on. */
export interface FakeSessionCore {
  readonly events: AsyncIterable<SessionEvent>;
  /** A no-op once ended. */
  emit(event: SessionEvent): void;
  /** Once: pushes `ended` (with `refusal` or `refusalBasis` only when given), ends the channel, runs onEnd callbacks. */
  end(
    reason: SessionEndReason,
    message: string | null,
    refusal?: AccountRefusal,
    basis?: ModelMarkBasis,
  ): void;
  ended(): boolean;
  onEnd(cleanup: () => void): void;
  /** Settles when end() has run. */
  readonly done: Promise<void>;
}

export function createFakeSessionCore(): FakeSessionCore {
  const channel = createChannel<SessionEvent>();
  const cleanups: (() => void)[] = [];
  let isEnded = false;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    finished = r;
  });
  return {
    events: channel,
    emit(event) {
      if (!isEnded) channel.push(event);
    },
    end(reason, message, refusal, basis) {
      if (isEnded) return;
      isEnded = true;
      channel.push({
        type: 'ended',
        reason,
        message,
        ...(refusal ? { refusal } : {}),
        ...(basis ? { refusalBasis: basis } : {}),
      });
      channel.end();
      for (const cleanup of cleanups) cleanup();
      finished();
    },
    ended: () => isEnded,
    onEnd(cleanup) {
      cleanups.push(cleanup);
    },
    done,
  };
}

/** A session that is only its `ended` event: the account refusals of both profiles. */
export function fakeEndedSession(ended: Extract<SessionEvent, { type: 'ended' }>): SessionHandle {
  const events = createChannel<SessionEvent>();
  events.push(ended);
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

/** Two handles open on one agent session: the runner or Plan has two writers on it. */
export class FakeSessionClashError extends Error {
  override readonly name = 'FakeSessionClashError';
  constructor(providerSessionId: string) {
    super(`A second handle was opened on agent session ${providerSessionId} while one is open.`);
  }
}

/**
 * The agent session a fake session runs under: the one it resumes, else the one it mints. The adapter
 * keys its one-open-handle check on it, and the session reports it in `started`.
 */
export function fakeProviderSessionId(spec: AgentSessionSpec, minted: string): string {
  return spec.resumeProviderSessionId ?? minted;
}

/** What the lane driver reads and records on the adapter; FakeAdapter builds one per open(). */
export interface FakeLaneContext {
  /** The agent session the lane runs under, as `fakeProviderSessionId` names it. */
  readonly providerSessionId: string;
  /** Runs once, when the session ends. */
  onEnded(): void;
  readonly title: string;
  readonly steps: readonly FakeStep[] | undefined;
  readonly reportedModel: string | undefined;
  readonly sent: FakeSent[];
  readonly observations: FakeObservation[];
  readonly interrupts: FakeInterrupt[];
  transcript(providerSessionId: string): Set<string>;
  taken(providerSessionId: string): string[];
  waitForSignal(name: string, untilStopped: Promise<'stopped'>): Promise<'signal' | 'stopped'>;
  interruptReceipt(untaken: readonly string[]): InterruptReceipt;
  interruptEndsSession(): boolean;
  stopGate(): Promise<void> | null;
}

/** Stands in for a lane's Claude Code session: the scripted steps drive every event. */
export function runFakeLaneSession(spec: LaneSessionSpec, context: FakeLaneContext): SessionHandle {
  const { title, steps, reportedModel } = context;
  const core = createFakeSessionCore();
  const emit = (event: SessionEvent): void => {
    core.emit(event);
  };
  const end: FakeSessionCore['end'] = (reason, message, refusal, basis) => {
    core.end(reason, message, refusal, basis);
  };
  const abort = new AbortController();
  const messages: string[] = [];
  const { providerSessionId } = context;
  core.onEnd(() => {
    context.onEnded();
  });
  const transcript = context.transcript(providerSessionId);
  const takenHere = context.taken(providerSessionId);
  /** The client uuids of the messages the session holds that no turn has taken yet, the prompt's first. */
  const untaken: string[] = [];
  /** What the running turn has taken, which its result lists again. */
  let takenThisTurn: string[] = [];
  /** A turn is running: a step of it ran and its result has not come. */
  let inTurn = false;
  /** The running turn's result, as Claude Code reports it: what it took, then its completion. */
  const completeTurn = (
    result: 'success' | 'max_turns' | 'error' | undefined,
    text?: string,
    dropped: readonly string[] = [],
  ) => {
    if (takenThisTurn.length > 0) emit({ type: 'consumed', uuids: takenThisTurn });
    takenThisTurn = [];
    inTurn = false;
    emit({
      type: 'turn_complete',
      ...(result ? { result } : {}),
      ...(text ? { text } : {}),
      ...(dropped.length > 0 ? { dropped } : {}),
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      costUsd: 0.01,
    });
  };
  /** Takes in a message unless its uuid is one the conversation already holds. */
  const receive = (uuid: string | undefined): void => {
    if (uuid === undefined || transcript.has(uuid)) return;
    transcript.add(uuid);
    untaken.push(uuid);
  };
  receive(spec.promptUuid);
  let messageWaiter: (() => void) | null = null;
  let mcp: Client | null = null;
  core.onEnd(() => {
    void mcp?.close();
  });

  const untilStopped = new Promise<'stopped'>((r) => {
    abort.signal.addEventListener('abort', () => {
      r('stopped');
    });
  });
  const observe = (
    step: number,
    kind: FakeObservation['kind'],
    detail: Record<string, unknown>,
  ): void => {
    context.observations.push({
      sessionId: spec.sessionId,
      sequence: spec.profile.sequence,
      title,
      step,
      kind,
      detail,
    });
  };

  // A throwing guard denies: the tool call must never proceed on a guard failure.
  const guardVerdict = (
    toolName: string,
    input: Record<string, unknown>,
    reportedMode: ReportedMode | undefined,
  ): GuardVerdict => {
    try {
      return spec.preToolUse({
        toolName,
        input,
        ...(reportedMode === undefined ? {} : { reportedMode }),
      });
    } catch (error) {
      return {
        decision: 'deny',
        reason: `guard failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const applyFileEffect = (toolName: string, input: Record<string, unknown>): void => {
    const file =
      typeof input['file_path'] === 'string' ? resolve(spec.cwd, input['file_path']) : null;
    if (!file) return;
    if (toolName === 'Write' && typeof input['content'] === 'string') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, input['content']);
    }
    if (
      toolName === 'Edit' &&
      typeof input['old_string'] === 'string' &&
      typeof input['new_string'] === 'string'
    ) {
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(input['old_string'], input['new_string']),
      );
    }
  };

  const callMcp = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> => {
    if (!mcp) {
      mcp = new Client({ name: 'fake-claude', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(spec.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${spec.mcp.token}` } },
      });
      await mcp.connect(transport);
    }
    const result = await mcp.callTool({ name: tool, arguments: args }, undefined, {
      timeout: spec.mcp.toolTimeoutMs,
      signal: abort.signal,
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('');
    return { isError: result.isError === true, text };
  };

  const runStep = async (step: FakeStep, index: number): Promise<'continue' | 'halt'> => {
    if (TURN_STEPS.has(step.do)) inTurn = true;
    switch (step.do) {
      case 'context':
        emit({
          type: 'context',
          percentage: step.percentage,
          totalTokens: step.percentage * 2000,
          maxTokens: 200_000,
        });
        return 'continue';
      case 'activity':
        emit({ type: 'activity', kind: 'text', summary: step.summary });
        return 'continue';
      case 'tool': {
        const input = step.input;
        emit({
          type: 'activity',
          kind: 'tool',
          summary: step.toolName,
          tool: claudeToolTarget(step.toolName, input),
        });
        const verdict = guardVerdict(step.toolName, input, step.reportedMode);
        if (verdict.decision === 'deny') {
          observe(index, 'denied_by_guard', { reason: verdict.reason });
          return 'continue';
        }
        let decision: ToolDecision = { behavior: 'allow' };
        // A guard `ask` reaches canUseTool past any allow rule, as Claude Code's hook ask does; a
        // settled allow never does, as with the hook's allow.
        const settled = verdict.decision === 'allow' && verdict.settled !== undefined;
        if (
          verdict.decision === 'ask' ||
          step.toolName === 'AskUserQuestion' ||
          (!settled &&
            !matchesAllowedTool(step.toolName, input, spec.profile.allowedTools, spec.cwd))
        ) {
          const asked = await Promise.race([
            spec.canUseTool({
              toolName: step.toolName,
              input,
              toolUseId: `fake-tool-${String(index)}`,
              escalated: false,
              signal: abort.signal,
            }),
            untilStopped,
          ]);
          if (asked === 'stopped') return 'halt';
          decision = asked;
        }
        if (decision.behavior === 'deny') {
          observe(index, 'tool_denied', { toolName: step.toolName, message: decision.message });
          return 'continue';
        }
        const effective = decision.updatedInput ?? input;
        applyFileEffect(step.toolName, effective);
        observe(index, 'tool_allowed', {
          toolName: step.toolName,
          ...(effective['answers'] ? { answers: effective['answers'] } : {}),
        });
        return 'continue';
      }
      case 'mcp': {
        const result = await Promise.race([callMcp(step.tool, step.args), untilStopped]);
        if (result === 'stopped') return 'halt';
        observe(index, 'mcp_result', {
          tool: step.tool,
          isError: result.isError,
          text: result.text,
        });
        return 'continue';
      }
      case 'await_signal':
        return (await context.waitForSignal(step.name, untilStopped)) === 'stopped'
          ? 'halt'
          : 'continue';
      case 'await_message': {
        for (;;) {
          if (messages.some((m) => m.includes(step.contains))) return 'continue';
          const woke = await Promise.race([
            new Promise<'message'>((r) => {
              messageWaiter = () => {
                r('message');
              };
            }),
            untilStopped,
          ]);
          if (woke === 'stopped') return 'halt';
        }
      }
      case 'consume': {
        const uuids = untaken.splice(0);
        takenThisTurn = [...takenThisTurn, ...uuids];
        takenHere.push(...uuids);
        if (uuids.length > 0) emit({ type: 'consumed', uuids });
        return 'continue';
      }
      case 'turn_complete':
        // The turn's result lists every message the turn took, as Claude Code's does.
        completeTurn(step.result, step.text, step.drops === true ? untaken.splice(0) : []);
        return 'continue';
      case 'rate_limit':
        emit({
          type: 'rate_limit',
          status: step.status,
          resetsAt:
            step.resetsInSeconds === null
              ? null
              : new Date(Date.now() + step.resetsInSeconds * 1000),
          utilization: step.utilization ?? null,
          limitType: step.limitType ?? null,
        });
        if (step.status === 'rejected') {
          end('rate_limited', 'usage limit reached');
          return 'halt';
        }
        return 'continue';
      case 'compact':
        emit({ type: 'compacted', trigger: 'auto' });
        return 'continue';
      case 'background':
        emit({
          type: 'background_tasks',
          tasks: step.tasks.map((description, i) => ({
            id: `fake-task-${String(i)}`,
            description,
          })),
        });
        return 'continue';
      case 'crash':
        end('error', step.message);
        return 'halt';
      case 'billing_refused':
        end(SessionEndReason.BillingRefused, step.message);
        return 'halt';
      case 'model_refused':
        end(
          SessionEndReason.ModelRefused,
          `The account cannot run the model ${spec.model}`,
          undefined,
          step.basis,
        );
        return 'halt';
      case 'auth_error':
        end(SessionEndReason.AccountRefused, `Claude Code reported ${step.error}`, {
          problem: credentialProblem(step.error) ?? AccountProblem.SignedOut,
          message: `Claude Code reported ${step.error}`,
          seenIdentity: null,
        });
        return 'halt';
      case 'hang':
        await untilStopped;
        return 'halt';
      case 'end':
        end(step.reason ?? 'completed', null);
        return 'halt';
    }
  };

  void (async () => {
    emit({ type: 'started', providerSessionId, pid: null });
    // The real CLI reports its session before any tool call; let the consumer see `started` first.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!modelMatches(spec.model, reportedModel ?? spec.model)) {
      end(
        SessionEndReason.BillingRefused,
        `Model check failed: 10db asked for ${spec.model} but Claude Code runs ${reportedModel ?? ''}.`,
      );
      return;
    }
    if (!steps) {
      end('error', `No fake script for "${title}" session ${String(spec.profile.sequence)}`);
      return;
    }
    try {
      // Every step that ends the session returns 'halt', so only a stop needs checking here.
      for (const [index, step] of steps.entries()) {
        if (abort.signal.aborted) break;
        if ((await runStep(step, index)) === 'halt') break;
      }
      end(abort.signal.aborted ? 'stopped' : 'completed', null);
    } catch (error) {
      end(
        abort.signal.aborted ? 'stopped' : 'error',
        error instanceof Error ? error.message : String(error),
      );
    }
  })();

  return {
    events: core.events,
    send(text, images = [], uuid) {
      context.sent.push({
        sessionId: spec.sessionId,
        text,
        images: images.length,
        uuid: uuid ?? null,
      });
      messages.push(text);
      receive(uuid);
      messageWaiter?.();
      messageWaiter = null;
    },
    interrupt() {
      // What no turn has taken yet stays queued and runs next, as far as the receipt says. The
      // running turn ends with an error result, as Claude Code's interrupted turn does.
      const receipt = context.interruptReceipt(untaken);
      context.interrupts.push({ sessionId: spec.sessionId, receipt });
      if (context.interruptEndsSession()) {
        end(SessionEndReason.Error, 'Codex did not end the interrupted turn in time.');
        return Promise.resolve(receipt);
      }
      if (inTurn) completeTurn('error');
      return Promise.resolve(receipt);
    },
    async stop() {
      const gate = context.stopGate();
      if (gate !== null) await gate;
      abort.abort();
      end('stopped', null);
      await core.done;
    },
  };
}

/** What a scripted turn of a fake Shape session did. */
export interface FakeShapeTurnResult {
  /** What the model wrote last. */
  readonly text?: string;
  /** The share of the context window in use after the turn; 10 when absent. */
  readonly contextPercent?: number;
  /** The account could not run the session's model: the session ends as refused, after no turn. */
  readonly refusedModel?: boolean;
}

/** One turn the fake runs for a message it was sent. */
export interface FakeShapeTurn {
  readonly spec: ExploreSessionSpec;
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

/**
 * Stands in for a Shape conversation's Claude Code session: each message it is sent runs the
 * scripted behaviour as one turn, and the turns run one after another.
 */
export function runFakeExploreSession(
  spec: ExploreSessionSpec,
  behaviour: FakeShapeBehaviour,
  providerSessionId: string,
  onEnded: () => void,
): SessionHandle {
  const core = createFakeSessionCore();
  core.onEnd(onEnded);
  const emit = (event: SessionEvent): void => {
    core.emit(event);
  };
  const queue: { text: string; images: readonly ShapeImage[] }[] = [];
  let wake: (() => void) | null = null;
  let current: AbortController | null = null;
  let number = 0;
  core.onEnd(() => {
    wake?.();
  });

  const guard = (request: ShapeToolRequest): ShapeVerdict => {
    try {
      return spec.preToolUse(request);
    } catch (error) {
      return { decision: 'deny', reason: `guard failed: ${String(error)}` };
    }
  };

  const loop = async (): Promise<void> => {
    emit({ type: 'started', providerSessionId, pid: null });
    queue.push({ text: spec.prompt, images: spec.images ?? [] });
    while (!core.ended()) {
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
          emit({ type: 'activity', kind: 'text', summary: String(error) });
        }
      }
      current = null;
      if (core.ended()) break;
      if (result.refusedModel === true) {
        core.end(
          'model_refused',
          `Claude Code reported that the account cannot run the model ${spec.model}.`,
        );
        break;
      }
      const percent = result.contextPercent ?? DEFAULT_CONTEXT_PERCENT;
      emit({
        type: 'context',
        percentage: percent,
        totalTokens: percent * 2_000,
        maxTokens: 200_000,
      });
      emit({
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
    events: core.events,
    send(text, images = []) {
      queue.push({ text, images });
      wake?.();
    },
    interrupt() {
      current?.abort();
      return Promise.resolve(null);
    },
    stop() {
      current?.abort();
      core.end('stopped', null);
      return Promise.resolve();
    },
  };
}
