import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AccountProblem,
  DeniedBy,
  type AccountRefusal,
  type ModelMarkBasis,
} from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { matchesAllowedTool } from '../permissions';
import { limitOfDenial, type ReportedMode } from '../trust';
import { credentialProblem, modelMatches } from './account-check';
import { createChannel } from './channel';
import {
  TURN_STEPS,
  type FakeInterrupt,
  type FakeObservation,
  type FakeSent,
  type FakeStep,
} from './fake-script';
import { FakeTaskRefs } from './fake-task-refs';
import { judgedVerdict } from './session-judge';
import { readCheckoutText } from './before-text';
import { claudeToolCall, claudeToolResult, createClaudeToolCalls } from './claude-tool-calls';
import {
  SessionEndReason,
  type InterruptReceipt,
  type SessionEvent,
  type SessionHandle,
  type AgentSessionCore,
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

/** A message as the fake streams it: the text split at its middle code point, then the whole. */
function sayEvents(itemId: string, text: string): SessionEvent[] {
  const points = Array.from(text);
  const first = points.slice(0, Math.floor(points.length / 2)).join('');
  const second = text.slice(first.length);
  return [
    ...(first === '' ? [] : [{ type: 'text_delta', itemId, offset: 0, text: first } as const]),
    { type: 'text_delta', itemId, offset: first.length, text: second },
    { type: 'message', itemId, text },
  ];
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
    setModel: () => Promise.resolve(),
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

/**
 * What a scripted session reads of its spec: a lane's, or a chat's that the book scripts too, given
 * the sequence of its sessions.
 */
export type ScriptedSessionSpec = AgentSessionCore & {
  readonly profile: Pick<LaneSessionSpec['profile'], 'sequence' | 'allowedTools'>;
};

/** Stands in for a lane's Claude Code session: the scripted steps drive every event. */
export function runFakeLaneSession(
  spec: ScriptedSessionSpec,
  context: FakeLaneContext,
): SessionHandle {
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
  let said = 0;
  let thought = 0;
  // Each scripted tool call is mapped as Claude Code's would be, its before-text read as the session reads it.
  const toolCalls = createClaudeToolCalls({
    now: () => new Date(),
    read: (_cwd, path) => readCheckoutText(spec.cwd, path),
  });
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
    toolUseId: string,
  ): GuardVerdict => {
    try {
      // The hook names the call, as Claude Code's does.
      return spec.preToolUse({
        toolName,
        input,
        toolUseId,
        ...(reportedMode === undefined ? {} : { reportedMode }),
      });
    } catch (error) {
      return {
        decision: 'deny',
        reason: `guard failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  /** The guard, then the session's judge for a call it left open, as Claude Code's hook runs them. */
  const sessionVerdict = (
    toolName: string,
    input: Record<string, unknown>,
    reportedMode: ReportedMode | undefined,
    toolUseId: string,
  ): Promise<GuardVerdict> =>
    judgedVerdict(spec, guardVerdict(toolName, input, reportedMode, toolUseId), {
      toolName,
      input,
      toolUseId,
      signal: abort.signal,
      hunk: null,
      ...(reportedMode === undefined ? {} : { reportedMode }),
    });

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

  const taskRefs = new FakeTaskRefs(spec.prompt);

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
        const toolUseId = `fake-tool-${String(index)}`;
        // The hook reads the file before the tool runs; the scripted call does as its use is mapped.
        toolCalls.capture(toolUseId, step.toolName, input, spec.cwd);
        for (const event of toolCalls.use({
          id: toolUseId,
          name: step.toolName,
          input,
          parentId: null,
        }))
          emit(event);
        const denied = (by: DeniedBy, reason: string): void => {
          toolCalls.deny(toolUseId, { by, reason, limit: null, soft: null });
          for (const event of toolCalls.result(toolUseId, { isError: true, content: reason }))
            emit(event);
        };
        // The sandbox's request for a host goes to canUseTool alone: it is no tool use, so no hook runs.
        const verdict: GuardVerdict =
          step.toolName === 'SandboxNetworkAccess'
            ? { decision: 'ask', reason: 'network request' }
            : await sessionVerdict(step.toolName, input, step.reportedMode, toolUseId);
        if (verdict.decision === 'deny') {
          denied(DeniedBy.TenDb, verdict.reason);
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
              toolUseId,
              escalated: false,
              signal: abort.signal,
            }),
            untilStopped,
          ]);
          if (asked === 'stopped') return 'halt';
          decision = asked;
        }
        if (decision.behavior === 'deny') {
          denied(DeniedBy.TenDb, decision.message);
          observe(index, 'tool_denied', { toolName: step.toolName, message: decision.message });
          return 'continue';
        }
        const effective = decision.updatedInput ?? input;
        applyFileEffect(step.toolName, effective);
        for (const event of toolCalls.result(toolUseId, {
          isError: false,
          content: step.result ?? '',
        }))
          emit(event);
        observe(index, 'tool_allowed', {
          toolName: step.toolName,
          ...(effective['answers'] ? { answers: effective['answers'] } : {}),
        });
        return 'continue';
      }
      case 'edit':
        return runStep(
          {
            do: 'tool',
            toolName: 'Write',
            input: { file_path: resolve(spec.cwd, step.path), content: step.text },
          },
          index,
        );
      case 'say':
        said += 1;
        for (const event of sayEvents(`fake-msg-${String(said)}`, step.text)) emit(event);
        return 'continue';
      case 'think':
        thought += 1;
        emit({
          type: 'reasoning_delta',
          itemId: `fake-thought-${String(thought)}`,
          offset: 0,
          text: step.text,
        });
        return 'continue';
      case 'plan':
        emit({ type: 'plan_update', steps: step.steps });
        return 'continue';
      case 'commands':
        emit({
          type: 'commands',
          commands: step.names.map((name) => ({ name, description: `/${name}` })),
        });
        return 'continue';
      case 'tool_call':
        emit({
          type: 'tool_call',
          call: step.call,
          ...(step.full === undefined
            ? {}
            : {
                full: {
                  ...(step.full.output === undefined ? {} : { output: step.full.output }),
                  ...(step.full.patch === undefined ? {} : { patch: step.full.patch }),
                },
              }),
        });
        return 'continue';
      case 'mcp': {
        const args = taskRefs.resolve(step.args);
        // A Claude session reports the use and the result of each tool call on 10db's server, which a
        // chat draws as its builder-tool rows.
        const useId = `fake-mcp-${String(index)}`;
        for (const event of toolCalls.use({
          id: useId,
          name: `mcp__10db__${step.tool}`,
          input: args,
          parentId: null,
        }))
          emit(event);
        const result = await Promise.race([callMcp(step.tool, args), untilStopped]);
        if (result === 'stopped') return 'halt';
        taskRefs.learn(result.text);
        for (const event of toolCalls.result(useId, {
          isError: result.isError,
          content: result.text,
        }))
          emit(event);
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
      case 'judge_denied':
        emit({
          type: 'judge_denied',
          call: {
            toolUseId: step.toolUseId ?? `fake-denied-${String(index)}`,
            toolName: step.toolName,
            summary: step.summary,
            reason: step.reason,
            by: step.by,
            limit: limitOfDenial(step.reason),
          },
        });
        return 'continue';
      case 'background':
        emit({
          type: 'background_tasks',
          tasks: step.tasks.map((task, i) => {
            const named = typeof task === 'string' ? { description: task } : task;
            return {
              id: `fake-task-${String(i)}`,
              description: named.description,
              ...('kind' in named && named.kind !== undefined ? { kind: named.kind } : {}),
              ...('agent' in named && named.agent !== undefined ? { agent: named.agent } : {}),
            };
          }),
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
    setModel: () => Promise.resolve(),
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
  /**
   * The turn ends dropping what it was handed and had not begun, as a Codex turn that fails does: the
   * messages leave the queue and `turn_complete` names them `dropped`.
   */
  readonly dropQueued?: boolean;
  /** The session ends after the turn's events, with no `turn_complete`: a limit, an error, an exit. */
  readonly end?: { readonly reason: SessionEndReason; readonly message: string | null };
}

/** One turn the fake runs for a message it was sent. */
interface FakeShapeTurn {
  readonly spec: ExploreSessionSpec;
  /** The message the turn answers. */
  readonly message: string;
  /** The images sent with it, as image content blocks. */
  readonly images: readonly ShapeImage[];
  /** The client uuid the message went under, when it carried one. */
  readonly uuid: string | null;
  /** Which message of this session it is, from 1. */
  readonly number: number;
  /** Aborts when the turn is interrupted. */
  readonly signal: AbortSignal;
  /** Reports an event of the turn as the agent would: a delta, a tool call, a plan. */
  emit(event: SessionEvent): void;
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
  interruptReceipt: (
    queued: readonly string[],
  ) => InterruptReceipt | Promise<InterruptReceipt> = () => null,
  startGate: () => Promise<void> | null = () => null,
): SessionHandle {
  const core = createFakeSessionCore();
  core.onEnd(onEnded);
  const emit = (event: SessionEvent): void => {
    core.emit(event);
  };
  const queue: { text: string; images: readonly ShapeImage[]; uuid: string | null }[] = [];
  let wake: (() => void) | null = null;
  let current: AbortController | null = null;
  let number = 0;
  core.onEnd(() => {
    wake?.();
  });

  let calls = 0;
  /** The last subagent the session started, which a subagent's own calls name as their parent. */
  let agentCall: string | null = null;
  /**
   * The session's PreToolUse hook, as Claude Code runs it before a call, and the call as Claude Code's
   * adapter reports it: running, then done, or denied with the hook's reason.
   */
  const guard = (request: ShapeToolRequest): ShapeVerdict => {
    let verdict: ShapeVerdict;
    try {
      verdict = spec.preToolUse(request);
    } catch (error) {
      verdict = { decision: 'deny', reason: `guard failed: ${String(error)}` };
    }
    calls += 1;
    const id = `fake-call-${String(calls)}`;
    const call = claudeToolCall(
      {
        id,
        name: request.toolName,
        input: request.input,
        parentId: request.agentId === undefined ? null : agentCall,
      },
      { startedAt: new Date(), before: () => ({ kind: 'unread' }) },
    );
    emit({ type: 'tool_call', call });
    if (verdict.decision === 'ask') return verdict;
    const denial =
      verdict.decision === 'deny'
        ? { by: DeniedBy.TenDb, reason: verdict.reason, limit: null, soft: null }
        : null;
    if (denial === null && request.toolName === 'Agent') agentCall = id;
    emit({
      type: 'tool_call',
      call: claudeToolResult(
        call,
        { isError: denial !== null, content: denial?.reason ?? '', denial },
        new Date(),
      ),
    });
    return verdict;
  };

  const loop = async (): Promise<void> => {
    await startGate();
    if (core.ended()) return;
    emit({ type: 'started', providerSessionId, pid: null });
    queue.push({ text: spec.prompt, images: spec.images ?? [], uuid: spec.promptUuid ?? null });
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
          uuid: next.uuid,
          number,
          signal: current.signal,
          guard,
          emit,
        });
      } catch (error) {
        if (!current.signal.aborted) {
          failed = true;
          emit({ type: 'activity', kind: 'text', summary: String(error) });
        }
      }
      // A stopped turn ends in error, as Claude Code's and Codex's interrupted turns do.
      const stopped = current.signal.aborted;
      current = null;
      if (core.ended()) break;
      if (result.end !== undefined) {
        core.end(result.end.reason, result.end.message);
        break;
      }
      if (result.refusedModel === true) {
        core.end(
          'model_refused',
          `Claude Code reported that the account cannot run the model ${spec.model}.`,
        );
        break;
      }
      if (!failed && result.text !== undefined && result.text !== '')
        for (const event of sayEvents(`fake-msg-${String(number)}`, result.text)) emit(event);
      const percent = result.contextPercent ?? DEFAULT_CONTEXT_PERCENT;
      emit({
        type: 'context',
        percentage: percent,
        totalTokens: percent * 2_000,
        maxTokens: 200_000,
      });
      const dropped =
        result.dropQueued === true
          ? queue.splice(0).flatMap((m) => (m.uuid === null ? [] : [m.uuid]))
          : [];
      emit({
        type: 'turn_complete',
        ...(dropped.length === 0 ? {} : { dropped }),
        ...(failed || stopped ? { result: 'error' as const } : {}),
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
    send(text, images = [], uuid) {
      queue.push({ text, images, uuid: uuid ?? null });
      wake?.();
    },
    async interrupt() {
      current?.abort();
      const receipt = await interruptReceipt(
        queue.flatMap((m) => (m.uuid === null ? [] : [m.uuid])),
      );
      // A message the receipt does not name was lost with the interrupted turn, as Claude Code's is.
      if (receipt !== null) {
        const named = new Set(receipt.stillQueued);
        for (const m of [...queue])
          if (m.uuid !== null && !named.has(m.uuid)) queue.splice(queue.indexOf(m), 1);
      }
      return receipt;
    },
    stop() {
      current?.abort();
      core.end('stopped', null);
      return Promise.resolve();
    },
    setModel: () => Promise.resolve(),
  };
}
