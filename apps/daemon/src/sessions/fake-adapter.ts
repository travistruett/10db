import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AccountKind,
  AccountProblem,
  ModelMarkBasis,
  Provider,
  providerOf,
  type AccountId,
  type AccountRefusal,
  type SessionId,
} from '@10db/contracts';
import { z } from 'zod';
import type { AccountExpectation } from '../environment';
import type { GuardVerdict } from '../guard';
import { matchesAllowedTool } from '../permissions';
import { checkAccount, credentialProblem, modelMatches, type SeenAccount } from './account-check';
import { createChannel } from './channel';
import {
  CompletionError,
  SessionEndReason,
  type AccountLogin,
  type AccountLoginOutcome,
  type AccountProbeSpec,
  type CompletionSpec,
  type InterruptReceipt,
  type SessionAdapter,
  type SessionEvent,
  type SessionHandle,
  type SessionSpec,
  type ShapeSessionHandle,
  type ShapeSessionSpec,
  type ToolDecision,
} from './types';
import { createFakeShapeSession, refusedShapeSession, type FakeShapeBehaviour } from './fake-shape';

const Json: z.ZodType = z.json();

/** The email the fake reports for a subscription that expects none, and for an identity probe. */
export const FAKE_ACCOUNT_EMAIL = 'builder@example.com';

const NOTHING_SEEN: SeenAccount = {
  email: undefined,
  organization: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
};

/** What a well-configured session of each kind reports: exactly what it expects. */
function expectedSeen(expect: AccountExpectation): SeenAccount {
  switch (expect.kind) {
    case AccountKind.ClaudeSubscription:
      return {
        ...NOTHING_SEEN,
        email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
        subscriptionType: 'Claude Max',
        apiProvider: 'firstParty',
        apiKeySource: 'none',
      };
    case AccountKind.AnthropicApiKey:
      return {
        ...NOTHING_SEEN,
        apiKeySource: 'ANTHROPIC_API_KEY',
        apiProvider: 'firstParty',
        organization: expect.identity ?? undefined,
      };
    case AccountKind.Bedrock:
      return {
        ...NOTHING_SEEN,
        apiProvider: 'bedrock',
        organization: expect.identity ?? undefined,
      };
    case AccountKind.Gateway:
      return {
        ...NOTHING_SEEN,
        apiProvider: 'firstParty',
        apiKeySource: 'none',
        tokenSource: 'ANTHROPIC_AUTH_TOKEN',
      };
    case AccountKind.CodexSignin:
      return {
        ...NOTHING_SEEN,
        email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
        subscriptionType: 'pro',
        apiProvider: 'chatgpt',
      };
  }
}

export const FakeStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('context'), percentage: z.number().min(0).max(100) }),
  z.object({ do: z.literal('activity'), summary: z.string() }),
  z.object({ do: z.literal('tool'), toolName: z.string(), input: z.record(z.string(), Json) }),
  z.object({ do: z.literal('mcp'), tool: z.string(), args: z.record(z.string(), Json) }),
  z.object({ do: z.literal('await_message'), contains: z.string() }),
  /**
   * A turn takes in every message the session holds that it has not taken yet, the prompt's first:
   * their client uuids come as `consumed`, as an assistant message stamps `user_message_uuids`.
   */
  z.object({ do: z.literal('consume') }),
  z.object({
    do: z.literal('turn_complete'),
    result: z.enum(['success', 'max_turns', 'error']).optional(),
    /** What the model wrote in the turn's last message. */
    text: z.string().optional(),
  }),
  z.object({
    do: z.literal('rate_limit'),
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsInSeconds: z.number().nullable(),
    utilization: z.number().optional(),
    limitType: z.string().optional(),
  }),
  z.object({ do: z.literal('compact') }),
  /** The commands running in the background now (none: they all finished). */
  z.object({ do: z.literal('background'), tasks: z.array(z.string()) }),
  z.object({ do: z.literal('crash'), message: z.string() }),
  z.object({ do: z.literal('billing_refused'), message: z.string() }),
  /** The account cannot run the model the session was launched on; `wording` is an error's text alone. */
  z.object({ do: z.literal('model_refused'), basis: z.enum(ModelMarkBasis).optional() }),
  z.object({
    do: z.literal('auth_error'),
    error: z.enum([
      'authentication_failed',
      'oauth_org_not_allowed',
      'cloud_credential_error',
      'billing_error',
      'account_on_hold',
    ]),
  }),
  z.object({ do: z.literal('hang') }),
  z.object({ do: z.literal('end'), reason: z.enum(['completed', 'rate_limited']).optional() }),
]);
export type FakeStep = z.infer<typeof FakeStep>;

/** Task title → one step list per session, indexed by the session's sequence within its workstream. */
export const FakeScriptBook = z.record(z.string(), z.array(z.array(FakeStep)));
export type FakeScriptBook = z.infer<typeof FakeScriptBook>;

/** Reads a script book from a JSON file, validating it at the file boundary. */
export function loadFakeScriptBook(path: string): FakeScriptBook {
  return FakeScriptBook.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface FakeObservation {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly title: string;
  readonly step: number;
  readonly kind: 'denied_by_guard' | 'tool_allowed' | 'tool_denied' | 'mcp_result';
  readonly detail: Record<string, unknown>;
}

/** Stands in for Claude Code at the adapter boundary; scripts drive every event. */
export class FakeAdapter implements SessionAdapter {
  readonly observations: FakeObservation[] = [];
  /** Every message the runner sent a session, in order, with how many images and the uuid it carried. */
  readonly sent: { sessionId: SessionId; text: string; images: number; uuid: string | null }[] = [];
  readonly prompts: {
    sessionId: SessionId;
    sequence: number;
    title: string;
    prompt: string;
    /** The prompt's client uuid, and how many images went with it. */
    promptUuid: string | null;
    images: number;
    resume: string | null;
    accountId: AccountId;
  }[] = [];
  /** Every lane session's interrupt, in order, with what it answered. */
  readonly interrupts: { sessionId: SessionId; receipt: InterruptReceipt }[] = [];
  /**
   * What a lane session's interrupt answers, from the uuids of the messages no turn has taken yet: by
   * default all of them as still queued, as a Claude Code that advertises `interrupt_receipt_v1` does;
   * null stands for one that answers nothing.
   */
  interruptReceipt: (untaken: readonly string[]) => InterruptReceipt = (untaken) => ({
    stillQueued: [...untaken],
  });

  /** What a session reports for its account, over what it expects; tests set it to stage a mismatch. */
  seen: (spec: SessionSpec) => Partial<SeenAccount> & { readonly model?: string } = () => ({});
  /** What an identity probe reports. */
  probeSeen: SeenAccount = {
    ...NOTHING_SEEN,
    email: FAKE_ACCOUNT_EMAIL,
    subscriptionType: 'Claude Max',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
  };
  readonly probes: AccountProbeSpec[] = [];
  /** Every browser sign-in started here, with a way to end it as the agent would. */
  readonly logins: {
    readonly spec: AccountProbeSpec;
    readonly end: (outcome: AccountLoginOutcome) => void;
    cancelled: boolean;
  }[] = [];
  /** Every question put to the model by `complete`. */
  readonly completions: CompletionSpec[] = [];
  /** What the model answers; the default has none, so a caller falls back to what it can do without. */
  answer: (ask: CompletionSpec) => Promise<string> = () =>
    Promise.reject(new CompletionError('The fake adapter has no model to ask.'));

  private readonly book: FakeScriptBook;

  constructor(book: FakeScriptBook) {
    this.book = book;
  }

  complete(ask: CompletionSpec): Promise<string> {
    this.completions.push(ask);
    return this.answer(ask);
  }

  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount> {
    this.probes.push(probe);
    return Promise.resolve(this.probeSeen);
  }

  startLogin(spec: AccountProbeSpec): Promise<AccountLogin> {
    let end: (outcome: AccountLoginOutcome) => void = () => undefined;
    const outcome = new Promise<AccountLoginOutcome>((resolve) => {
      end = resolve;
    });
    const record = { spec, end, cancelled: false };
    this.logins.push(record);
    return Promise.resolve({
      // Codex names the page to open; Claude Code opens the browser itself.
      authUrl:
        providerOf(spec.kind) === Provider.Codex
          ? 'https://auth.openai.com/oauth/authorize?state=fake'
          : null,
      outcome,
      cancel() {
        record.cancelled = true;
        end({ ok: false, message: 'The sign-in was cancelled.' });
        return Promise.resolve();
      },
    });
  }

  /** What each Shape session started here ran with, and what it was sent after its first message. */
  readonly shapeSessions: {
    readonly spec: ShapeSessionSpec;
    readonly sent: string[];
    readonly handle: ShapeSessionHandle;
  }[] = [];
  /** How a Shape session answers a message; the default writes a short reply. */
  shapeBehaviour: FakeShapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
  /**
   * When set, a Shape session's stop waits for it before the session ends, as a real process can
   * take seconds to close after it is asked to.
   */
  shapeStopGate: Promise<void> | null = null;

  startShape(spec: ShapeSessionSpec): ShapeSessionHandle {
    const refusal = checkAccount(spec.account, expectedSeen(spec.account));
    const sent: string[] = [];
    const inner = refusal
      ? refusedShapeSession(refusal.message)
      : createFakeShapeSession(
          spec,
          (turn) => this.shapeBehaviour(turn),
          `fake-shape-${String(this.shapeSessions.length + 1)}`,
        );
    const handle: ShapeSessionHandle = {
      events: inner.events,
      send: (text, images) => {
        sent.push(text);
        inner.send(text, images);
      },
      interrupt: () => inner.interrupt(),
      stop: async () => {
        if (this.shapeStopGate !== null) await this.shapeStopGate;
        await inner.stop();
      },
    };
    this.shapeSessions.push({ spec, sent, handle });
    return handle;
  }

  start(spec: SessionSpec): SessionHandle {
    const sent = this.sent;
    const { model: reportedModel, ...override } = this.seen(spec);
    const refusal = checkAccount(spec.account, { ...expectedSeen(spec.account), ...override });
    if (refusal) {
      const refused = createChannel<SessionEvent>();
      refused.push({
        type: 'ended',
        reason: SessionEndReason.AccountRefused,
        message: `${refusal.message}. No prompt was sent.`,
        refusal,
      });
      refused.end();
      return {
        events: refused,
        send: () => undefined,
        interrupt: () => Promise.resolve(null),
        stop: () => Promise.resolve(),
      };
    }
    const title = Object.keys(this.book).find((t) => spec.prompt.includes(`Task: ${t}\n`)) ?? '';
    const steps = this.book[title]?.[spec.sequence - 1];
    this.prompts.push({
      sessionId: spec.sessionId,
      sequence: spec.sequence,
      title,
      prompt: spec.prompt,
      promptUuid: spec.promptUuid ?? null,
      images: spec.images?.length ?? 0,
      resume: spec.resumeProviderSessionId,
      accountId: spec.account.accountId,
    });

    const channel = createChannel<SessionEvent>();
    const abort = new AbortController();
    const messages: string[] = [];
    /** The client uuids of the messages the session holds that no turn has taken yet, the prompt's first. */
    const untaken: string[] = spec.promptUuid === undefined ? [] : [spec.promptUuid];
    let messageWaiter: (() => void) | null = null;
    let ended = false;
    let mcp: Client | null = null;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      finished = r;
    });

    const end = (
      reason: SessionEndReason,
      message: string | null,
      refusal?: AccountRefusal,
      basis?: ModelMarkBasis,
    ): void => {
      if (ended) return;
      ended = true;
      channel.push({
        type: 'ended',
        reason,
        message,
        ...(refusal ? { refusal } : {}),
        ...(basis ? { refusalBasis: basis } : {}),
      });
      channel.end();
      void mcp?.close();
      finished();
    };
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
      this.observations.push({
        sessionId: spec.sessionId,
        sequence: spec.sequence,
        title,
        step,
        kind,
        detail,
      });
    };

    // A throwing guard denies: the tool call must never proceed on a guard failure.
    const guardVerdict = (toolName: string, input: Record<string, unknown>): GuardVerdict => {
      try {
        return spec.preToolUse({ toolName, input });
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
      switch (step.do) {
        case 'context':
          channel.push({
            type: 'context',
            percentage: step.percentage,
            totalTokens: step.percentage * 2000,
            maxTokens: 200_000,
          });
          return 'continue';
        case 'activity':
          channel.push({ type: 'activity', kind: 'text', summary: step.summary });
          return 'continue';
        case 'tool': {
          const input = step.input;
          channel.push({ type: 'activity', kind: 'tool', summary: step.toolName });
          const verdict = guardVerdict(step.toolName, input);
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
            (!settled && !matchesAllowedTool(step.toolName, input, spec.allowedTools, spec.cwd))
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
          if (uuids.length > 0) channel.push({ type: 'consumed', uuids });
          return 'continue';
        }
        case 'turn_complete':
          channel.push({
            type: 'turn_complete',
            ...(step.result ? { result: step.result } : {}),
            ...(step.text ? { text: step.text } : {}),
            inputTokens: 1000,
            outputTokens: 200,
            cachedTokens: 0,
            costUsd: 0.01,
          });
          return 'continue';
        case 'rate_limit':
          channel.push({
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
          channel.push({ type: 'compacted', trigger: 'auto' });
          return 'continue';
        case 'background':
          channel.push({
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
      channel.push({
        type: 'started',
        providerSessionId: spec.resumeProviderSessionId ?? `fake-${spec.sessionId}`,
        pid: null,
      });
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
        end('error', `No fake script for "${title}" session ${String(spec.sequence)}`);
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

    const interrupts = this.interrupts;
    const receiptFor = (untakenNow: readonly string[]): InterruptReceipt =>
      this.interruptReceipt(untakenNow);
    return {
      events: channel,
      send(text, images = [], uuid) {
        sent.push({ sessionId: spec.sessionId, text, images: images.length, uuid: uuid ?? null });
        messages.push(text);
        if (uuid !== undefined) untaken.push(uuid);
        messageWaiter?.();
        messageWaiter = null;
      },
      interrupt() {
        // What no turn has taken yet stays queued and runs next, as far as the receipt says.
        const receipt = receiptFor(untaken);
        interrupts.push({ sessionId: spec.sessionId, receipt });
        return Promise.resolve(receipt);
      },
      async stop() {
        abort.abort();
        end('stopped', null);
        await done;
      },
    };
  }
}
