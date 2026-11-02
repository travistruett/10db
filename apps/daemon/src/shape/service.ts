import {
  ConflictError,
  EventType,
  InvalidError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  SessionMode,
  type DecisionId,
  type Effort,
  type GoalId,
  type ProjectId,
  type ShapeDto,
  type ShapeId,
  type ShapeMessageDto,
  type ShapeOrigin,
  type ShapeProposalId,
  type ShapeViewDto,
  type SessionId,
} from '@10db/contracts';
import {
  endSession,
  findShapeLinkOfGoal,
  getShape,
  getShapeSdkSessionId,
  insertSession,
  insertShape,
  insertShapeMessage,
  listShapeMessages,
  listShapes,
  markSessionStarted,
  patchShape,
  updateSessionUsage,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { AccountExpectation } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { mintSessionToken, type ShapeToolsFor } from '../mcp';
import type {
  SessionAdapter,
  SessionEvent,
  ShapeSessionHandle,
  ShapeSessionSpec,
  TurnResult,
} from '../sessions';
import { judgeShapeCall, type ShapeAccess } from './confinement';
import { convertProposals, type ConvertOutcome } from './convert';
import { buildDigest } from './digest';
import {
  proposeNote,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
} from './policy';
import { createShapeToolHandlers } from './tools';
import { removeDraftGoalOf, withdrawConvertedDecision } from './undo';
import { buildShapeView } from './view';

// Shape spec §5.1, §5.3, §6, §11. Runs each conversation's session: one turn at a time, a queue, the
// Propose and Convert guards, the move to a fresh session when the context fills, and the idle close.

/** What a conversation's session launches with: the project's checkout and the `plan` role's model. */
export interface ShapeLaunch {
  readonly cwd: string;
  readonly model: string;
  readonly effort: Effort;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
  readonly access: ShapeAccess;
}

export interface ShapeServiceDeps {
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly clock: Clock;
  readonly log: Logger;
  readonly mcp: { readonly url: string; readonly toolTimeoutMs: number };
  /** Resolves a project's launch; throws when its account can't start a session. */
  launch(projectId: ProjectId): ShapeLaunch;
  /** How long a session idles before its process closes; 10 minutes. */
  readonly idleMs?: number;
  /** The share of the context window past which a conversation moves to a fresh session; 70. */
  readonly contextLimitPct?: number;
}

export interface ShapeService {
  create(projectId: ProjectId, input: { title: string; origin: ShapeOrigin }): ShapeDto;
  /** Records a builder message and queues its turn. */
  send(shapeId: ShapeId, text: string): ShapeMessageDto;
  /** Queues a Propose turn, or ignores the press while a Propose turn is queued or running. */
  propose(shapeId: ShapeId): { status: 'started' | 'ignored' };
  /** Interrupts the turn that is running; the queue runs next. */
  stop(shapeId: ShapeId): Promise<void>;
  /** Everything the screen renders for the conversation, with where its session is. */
  view(shapeId: ShapeId): ShapeViewDto;
  /** The project's conversations, the one touched last first. */
  list(projectId: ProjectId): ShapeDto[];
  /**
   * Remove Draft Goal (spec §11), found through the conversation that made the goal. Throws
   * InvalidError for a goal no conversation made and ConflictError once a task has started.
   */
  removeDraftGoal(goalId: GoalId): void;
  /** Withdraw Decision…: a decision the conversation wrote, with the builder's reason. */
  withdrawDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /**
   * Converts the selected proposals. Refused with a `ConflictError` while a turn runs, unless the
   * caller asks to interrupt it. Holds the queue while it writes.
   */
  convert(
    shapeId: ShapeId,
    proposalIds: readonly ShapeProposalId[],
    options?: { interrupt?: boolean },
  ): Promise<ConvertOutcome>;
  /** The handlers the MCP endpoint serves a conversation's session. */
  readonly toolsFor: ShapeToolsFor;
  /** Resolves when no turn is running or queued. */
  settled(shapeId: ShapeId): Promise<void>;
  /** Stops every session. */
  close(): Promise<void>;
}

/** A conversation's name until its first message gives it one. */
export const DEFAULT_SHAPE_TITLE = 'New conversation';
const TITLE_MAX = 60;

/** The first non-empty line of a message, cut to fit a title. */
function titleFrom(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const IDLE_MS = 10 * 60_000;
const CONTEXT_LIMIT_PCT = 70;

interface Turn {
  readonly kind: 'message' | 'propose';
  /** What the session is sent, with the id of the message it answers. */
  readonly prompt: string;
}

type TurnEnd =
  | { readonly kind: 'complete'; readonly result: TurnResult | undefined }
  | { readonly kind: 'ended' };

interface Live {
  readonly handle: ShapeSessionHandle;
  readonly sessionId: SessionId;
  /** Why the daemon ended it, when it did; the session's exit reason otherwise comes from Claude Code. */
  endReason: string | null;
  /** Resolves when its events have ended: the session has ended and its row says so. */
  done: Promise<void>;
}

interface Runtime {
  readonly queue: Turn[];
  current: Turn | null;
  live: Live | null;
  /** Resolves the running turn, when the session says it ended. */
  waiting: ((end: TurnEnd) => void) | null;
  /** Set while Convert writes: no new turn starts. */
  held: boolean;
  pump: Promise<void> | null;
  idle: Timer | null;
  contextPct: number;
  /** Whether the turn running now has had an accepted propose_plan call, and how many were refused. */
  proposed: boolean;
  refused: number;
  /** Stop or Convert interrupted the turn running now. */
  interrupted: boolean;
  /**
   * Resolves when the session the daemon last closed has ended. No new session starts before it,
   * so two processes never run, or resume the same SDK session, at once.
   */
  closing: Promise<void> | null;
}

export function createShapeService(deps: ShapeServiceDeps): ShapeService {
  const { state, adapter, clock, log } = deps;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const contextLimit = deps.contextLimitPct ?? CONTEXT_LIMIT_PCT;
  const runtimes = new Map<ShapeId, Runtime>();

  const runtimeOf = (shapeId: ShapeId): Runtime => {
    let rt = runtimes.get(shapeId);
    if (rt === undefined) {
      rt = {
        queue: [],
        current: null,
        live: null,
        waiting: null,
        held: false,
        pump: null,
        idle: null,
        contextPct: 0,
        proposed: false,
        refused: 0,
        interrupted: false,
        closing: null,
      };
      runtimes.set(shapeId, rt);
    }
    return rt;
  };

  const say = (
    shapeId: ShapeId,
    author: ShapeMessageAuthor,
    kind: ShapeMessageKind,
    body: string,
  ): ShapeMessageDto =>
    state.write((ctx) => insertShapeMessage(ctx, shapeId, { author, kind, body }));
  const notice = (shapeId: ShapeId, body: string): void => {
    say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Notice, body);
  };

  /** Tells the screen the conversation changed, for what no row records (where its session is). */
  const announce = (shapeId: ShapeId): void => {
    state.write((ctx) => {
      ctx.emit({
        type: EventType.ShapeChanged,
        entityType: 'shape',
        entityId: shapeId,
        data: { projectId: getShape(ctx.tx, shapeId).projectId },
      });
    });
  };

  const toolsFor: ShapeToolsFor = ({ shapeId }) =>
    createShapeToolHandlers(
      {
        state,
        onProposal: (id, accepted) => {
          const rt = runtimeOf(id);
          if (accepted) rt.proposed = true;
          else rt.refused += 1;
        },
      },
      shapeId,
    );

  // --- Events from a session --------------------------------------------------------------------

  const onEvent = (shapeId: ShapeId, rt: Runtime, live: Live, event: SessionEvent): void => {
    // A session the daemon has closed still records its own row, but it no longer runs the
    // conversation: its events never end the turn of the session that replaced it.
    const running = rt.live === live;
    switch (event.type) {
      case 'started':
        state.write((ctx) => {
          markSessionStarted(ctx, live.sessionId, event.providerSessionId, event.pid);
          patchShape(ctx, shapeId, { sdkSessionId: event.providerSessionId });
        });
        break;
      case 'context':
        rt.contextPct = event.percentage;
        state.write((ctx) => {
          updateSessionUsage(ctx, live.sessionId, { contextPct: event.percentage });
        });
        break;
      case 'turn_complete':
        state.write((ctx) => {
          updateSessionUsage(ctx, live.sessionId, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cachedTokens: event.cachedTokens,
            costUsd: event.costUsd,
          });
          // The reply and the usage land together: a turn the transcript shows is a turn counted.
          if (event.text !== undefined && event.text !== '')
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Claude,
              kind: ShapeMessageKind.Text,
              body: event.text,
            });
        });
        if (running) rt.waiting?.({ kind: 'complete', result: event.result });
        break;
      case 'rate_limit':
        if (event.status === 'rejected')
          notice(
            shapeId,
            event.resetsAt === null
              ? 'Claude is rate limited; try again later.'
              : `Claude is rate limited until ${event.resetsAt.toISOString()}; try again then.`,
          );
        break;
      case 'ended':
        state.write((ctx) => {
          endSession(ctx, live.sessionId, live.endReason ?? event.reason);
        });
        if (running) rt.live = null;
        if (live.endReason === null && event.reason !== 'completed' && event.reason !== 'stopped')
          notice(shapeId, event.message ?? `Claude's session ended (${event.reason}).`);
        if (running) rt.waiting?.({ kind: 'ended' });
        break;
      case 'activity':
      case 'compacted':
        break;
    }
  };

  const consume = async (shapeId: ShapeId, rt: Runtime, live: Live): Promise<void> => {
    try {
      for await (const event of live.handle.events) onEvent(shapeId, rt, live, event);
    } catch (error) {
      log.error({ err: error, shapeId }, 'shape session events failed');
    }
  };

  // --- Starting a session -----------------------------------------------------------------------

  /** Starts the conversation's session with `prompt` as its first message. */
  const start = (shapeId: ShapeId, rt: Runtime, turn: Turn): void => {
    const shape = getShape(state.db, shapeId);
    const launch = deps.launch(shape.projectId);
    const resumeId = getShapeSdkSessionId(state.db, shapeId);
    let prompt = turn.prompt;
    // No session to resume, and Claude has spoken: a session that lost it starts from the digest,
    // which is stored so what it saw is on record.
    const spoken = listShapeMessages(state.db, shapeId).some(
      (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text,
    );
    if (resumeId === null && spoken) {
      const digest = buildDigest(state.db, shapeId);
      say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Digest, digest);
      prompt = `${digest}\n\n${turn.prompt}`;
    }
    const { token, hash } = mintSessionToken();
    const row = state.write((ctx) =>
      insertSession(ctx, {
        shapeId,
        provider: adapter.provider,
        model: launch.model,
        effort: launch.effort,
        mode: SessionMode.Managed,
        mcpTokenHash: hash,
      }),
    );
    const spec: ShapeSessionSpec = {
      sessionId: row.id,
      shapeId,
      cwd: launch.cwd,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      prompt,
      model: launch.model,
      effort: launch.effort,
      resumeProviderSessionId: resumeId,
      env: launch.env,
      account: launch.account,
      tools: [...SHAPE_BUILT_IN_TOOLS],
      allowedTools: SHAPE_ALLOWED_TOOLS,
      disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
      agents: {},
      mcp: { url: deps.mcp.url, token, toolTimeoutMs: deps.mcp.toolTimeoutMs },
      preToolUse: (req) => {
        const verdict = judgeShapeCall(
          {
            toolName: req.toolName,
            toolInput: req.input,
            agentId: req.agentId,
            agentType: req.agentType,
          },
          launch.access,
        );
        if (verdict.decision === 'deny')
          say(
            shapeId,
            ShapeMessageAuthor.Claude,
            ShapeMessageKind.Tool,
            `${req.toolName} · refused · ${verdict.reason}`,
          );
        return verdict;
      },
    };
    const live: Live = {
      handle: adapter.startShape(spec),
      sessionId: row.id,
      endReason: null,
      done: Promise.resolve(),
    };
    rt.live = live;
    live.done = consume(shapeId, rt, live);
  };

  /** Stops the running session; resolves, as `rt.closing` does, once it has ended. */
  const closeLive = (rt: Runtime, reason: string): Promise<void> => {
    const live = rt.live;
    if (live === null) return rt.closing ?? Promise.resolve();
    live.endReason = reason;
    rt.live = null;
    // A turn waiting on this session ends with it: its own `ended` event no longer counts.
    rt.waiting?.({ kind: 'ended' });
    const previous = rt.closing;
    const closing = (async () => {
      try {
        await live.handle.stop();
      } catch (error) {
        log.warn({ err: error, sessionId: live.sessionId }, 'shape session did not stop cleanly');
      }
      await live.done;
      await previous;
    })();
    rt.closing = closing;
    void closing.finally(() => {
      if (rt.closing === closing) rt.closing = null;
    });
    return closing;
  };

  const armIdle = (rt: Runtime): void => {
    rt.idle?.cancel();
    rt.idle = clock.setTimeout(() => {
      rt.idle = null;
      if (rt.current !== null || rt.queue.length > 0 || rt.held) return;
      void closeLive(rt, 'idle');
    }, idleMs);
  };

  // --- Turns ------------------------------------------------------------------------------------

  const runTurn = async (shapeId: ShapeId, rt: Runtime, turn: Turn): Promise<void> => {
    rt.idle?.cancel();
    rt.idle = null;
    rt.proposed = false;
    rt.refused = 0;
    rt.interrupted = false;
    // The turn counts as running (rt.current) while the last session finishes closing.
    if (rt.live === null && rt.closing !== null) await rt.closing;
    const ended = new Promise<TurnEnd>((resolve) => {
      rt.waiting = resolve;
    });
    try {
      if (rt.live === null) start(shapeId, rt, turn);
      else rt.live.handle.send(turn.prompt);
    } catch (error) {
      rt.waiting = null;
      log.warn({ err: error, shapeId }, 'shape session could not start');
      notice(
        shapeId,
        `Claude could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const end = await ended;
    rt.waiting = null;
    // Read through a function: Stop sets the flag while the turn is awaited, which narrowing misses.
    const stopped = (): boolean => rt.interrupted;
    const proposedIn = (): boolean => rt.proposed;
    const failed = end.kind === 'complete' && end.result === 'error' && !stopped();
    if (failed) notice(shapeId, "Claude's turn failed; send the message again.");
    if (end.kind === 'complete' && !failed && !stopped() && turn.kind === 'propose') {
      if (!proposedIn()) {
        log.info({ shapeId, refusedProposals: rt.refused }, 'a propose turn proposed nothing');
        notice(shapeId, "Claude didn't propose; Propose Again");
      }
    }
    if (end.kind === 'ended') return;
    if (rt.contextPct > contextLimit) {
      // The next turn starts a fresh session from the digest; nothing the builder said is lost.
      await closeLive(rt, 'continued');
      state.write((ctx) => {
        patchShape(ctx, shapeId, { sdkSessionId: null });
      });
      rt.contextPct = 0;
      notice(shapeId, 'Continued in a fresh session; nothing is lost');
      return;
    }
    armIdle(rt);
  };

  const pump = (shapeId: ShapeId, rt: Runtime): void => {
    if (rt.pump !== null) return;
    rt.pump = (async () => {
      try {
        while (rt.queue.length > 0 && !rt.held) {
          const turn = rt.queue.shift();
          if (turn === undefined) break;
          rt.current = turn;
          announce(shapeId);
          try {
            await runTurn(shapeId, rt, turn);
          } catch (error) {
            log.error({ err: error, shapeId }, 'a shape turn failed');
            notice(shapeId, "Claude's turn failed; send the message again.");
          } finally {
            rt.current = null;
            announce(shapeId);
          }
        }
      } finally {
        rt.pump = null;
      }
    })();
  };

  const interrupt = async (rt: Runtime): Promise<void> => {
    rt.interrupted = true;
    await rt.live?.handle.interrupt();
  };

  const settled = async (shapeId: ShapeId): Promise<void> => {
    const rt = runtimeOf(shapeId);
    while (rt.pump !== null) await rt.pump;
  };

  return {
    create: (projectId, input) => state.write((ctx) => insertShape(ctx, projectId, input)),

    send(shapeId, text) {
      const rt = runtimeOf(shapeId);
      const message = say(shapeId, ShapeMessageAuthor.Builder, ShapeMessageKind.Text, text);
      const title = titleFrom(text);
      if (title !== '' && getShape(state.db, shapeId).title === DEFAULT_SHAPE_TITLE)
        state.write((ctx) => {
          patchShape(ctx, shapeId, { title });
        });
      rt.queue.push({ kind: 'message', prompt: `[m:${message.id}] ${text}` });
      pump(shapeId, rt);
      return message;
    },

    propose(shapeId) {
      const rt = runtimeOf(shapeId);
      if (rt.current?.kind === 'propose' || rt.queue.some((t) => t.kind === 'propose'))
        return { status: 'ignored' };
      const { note, instruction } = proposeNote(getShape(state.db, shapeId).round > 0);
      // The press unlocks propose_plan for good and is a row in the transcript, in one write.
      const message = state.write((ctx) => {
        patchShape(ctx, shapeId, { proposeUnlocked: true });
        return insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Propose,
          body: note,
        });
      });
      rt.queue.push({ kind: 'propose', prompt: `[m:${message.id}] ${instruction}` });
      pump(shapeId, rt);
      return { status: 'started' };
    },

    view(shapeId) {
      const rt = runtimes.get(shapeId);
      const queue = rt?.queue ?? [];
      return buildShapeView(state.db, shapeId, {
        running: rt !== undefined && rt.current !== null,
        queued: queue.length,
        proposing: rt?.current?.kind === 'propose' || queue.some((t) => t.kind === 'propose'),
      });
    },

    list: (projectId) =>
      listShapes(state.db, projectId).sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      ),

    removeDraftGoal(goalId) {
      state.write((ctx) => {
        const link = findShapeLinkOfGoal(ctx.tx, goalId);
        if (link === undefined)
          throw new InvalidError(`${goalId} is not a goal a conversation made`);
        removeDraftGoalOf(ctx, link.shapeId, goalId);
      });
    },

    withdrawDecision(shapeId, decisionId, reason) {
      state.write((ctx) => {
        withdrawConvertedDecision(ctx, shapeId, decisionId, reason);
        ctx.emit({
          type: EventType.ShapeChanged,
          entityType: 'shape',
          entityId: shapeId,
          data: { projectId: getShape(ctx.tx, shapeId).projectId },
        });
      });
    },

    async stop(shapeId) {
      const rt = runtimeOf(shapeId);
      if (rt.current !== null) await interrupt(rt);
    },

    async convert(shapeId, proposalIds, options) {
      const rt = runtimeOf(shapeId);
      if (rt.current !== null) {
        if (options?.interrupt !== true)
          throw new ConflictError('Claude is still answering; Stop or wait');
        rt.held = true;
        await interrupt(rt);
        while (rt.pump !== null) await rt.pump;
      }
      rt.held = true;
      try {
        return state.write((ctx) => {
          const outcome = convertProposals(ctx, shapeId, proposalIds);
          if (outcome.ok && outcome.createdNow > 0)
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Note,
              kind: ShapeMessageKind.Event,
              body: `Converted ${String(outcome.createdNow)} ${outcome.createdNow === 1 ? 'proposal' : 'proposals'}`,
            });
          return outcome;
        });
      } finally {
        rt.held = false;
        pump(shapeId, rt);
      }
    },

    toolsFor,
    settled,

    async close() {
      for (const rt of runtimes.values()) {
        rt.idle?.cancel();
        rt.idle = null;
        rt.queue.length = 0;
        await closeLive(rt, 'stopped');
      }
    },
  };
}
