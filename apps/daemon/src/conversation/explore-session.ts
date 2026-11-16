import {
  EventType,
  type BackgroundTaskDto,
  type ConversationId,
  type ConversationItemId,
  type SessionId,
} from '@10db/contracts';
import { taskKind } from './background-task-kind';
import { markSessionStarted, patchConversation, updateSessionUsage } from '@10db/db';
import type { Clock } from '../clock';
import type { LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import type { AgentCommand, SessionEvent, SessionHandle } from '../sessions';
import type { ExploreLaunch } from './explore-hooks';
import { createItemRecorder } from './item-recorder';
import type { LiveBuffers } from './live-buffers';

// Sessions spec §6.5, §6.6: one open explore session. Its items are the library's item recorder's
// (each stored under the id its buffer minted, capped). What the reducer needs (started, a turn's end, the session's end) goes
// to the engine.

type TurnComplete = Extract<SessionEvent, { type: 'turn_complete' }>;
type Ended = Extract<SessionEvent, { type: 'ended' }>;

/** What the engine hears from an open session. */
export interface SessionSink {
  started(providerSessionId: string): void;
  consumed(uuids: readonly string[]): void;
  rateLimited(resetsAt: Date | null): void;
  turnComplete(event: TurnComplete): void;
  ended(event: Ended): void;
}

export interface OpenSession {
  readonly sessionId: SessionId;
  readonly handle: SessionHandle;
  readonly launch: ExploreLaunch;
  readonly buffers: LiveBuffers;
  /** The session started with nothing to resume. */
  readonly fresh: boolean;
  /** The slash commands the session offers, for the composer. */
  readonly commands: () => readonly AgentCommand[];
  /** The background commands and subagents the session reports as running. */
  readonly backgroundTasks: () => readonly BackgroundTaskDto[];
  /** Reads no more events but `ended`. */
  detach(): void;
  /**
   * The running turn is over for the engine though its own events are still to come (a receipt settled
   * its stop): they are dropped, up to and including its `turn_complete`.
   */
  skipTurn(): void;
  /** Stores what streamed, marked partial, and empties the buffers. */
  storePartial(): ConversationItemId[];
  /** A turn begins: its plan is a new item. */
  newTurn(): void;
  /** Resolves when the session's events have ended. */
  readonly done: Promise<void>;
}

export interface OpenSessionDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly dataDir: string;
  readonly frames: LiveFrames;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly handle: SessionHandle;
  readonly launch: ExploreLaunch;
  readonly fresh: boolean;
  readonly sink: SessionSink;
}

export function openSession(deps: OpenSessionDeps): OpenSession {
  const { state, conversationId, sessionId, sink } = deps;
  const items = createItemRecorder({
    state,
    clock: deps.clock,
    log: deps.log,
    dataDir: deps.dataDir,
    frames: deps.frames,
    conversationId,
  });
  let detached = false;
  /** Turns whose remaining events are dropped, oldest first: each ends with its `turn_complete`. */
  let skipping = 0;
  let commands: readonly AgentCommand[] = [];
  let backgroundTasks: readonly BackgroundTaskDto[] = [];

  const onEvent = (event: SessionEvent): void => {
    if (detached && event.type !== 'ended') return;
    if (event.type === 'background_tasks') {
      backgroundTasks = event.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        kind: taskKind(t.kind),
        agent: t.agent ?? null,
      }));
      // Not stored: the view reads it from the open session, and this tells the screen to read the view.
      state.write((ctx) => {
        ctx.emit({
          type: EventType.ConversationState,
          entityType: 'conversation',
          entityId: conversationId,
          data: { backgroundTasks: true },
        });
      });
      return;
    }
    if (skipping > 0 && event.type !== 'ended') {
      if (event.type === 'turn_complete') skipping -= 1;
      return;
    }
    switch (event.type) {
      case 'started':
        state.write((ctx) => {
          markSessionStarted(ctx, sessionId, event.providerSessionId, event.pid);
          patchConversation(ctx, conversationId, { providerSessionId: event.providerSessionId });
        });
        if (event.pid !== null) deps.launch.track(event.pid);
        sink.started(event.providerSessionId);
        return;
      case 'text_delta':
      case 'reasoning_delta':
      case 'message':
      case 'tool_call':
      case 'plan_update':
        items.record(event);
        return;
      case 'commands':
        commands = event.commands;
        // Kept on the conversation, so a cold one still offers `/`; the screen reads the view again.
        state.write((ctx) => {
          patchConversation(ctx, conversationId, {
            commands: event.commands.map((c) => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint ?? null,
            })),
          });
          ctx.emit({
            type: EventType.ConversationState,
            entityType: 'conversation',
            entityId: conversationId,
            data: { commands: true },
          });
        });
        return;
      case 'context':
        state.write((ctx) => {
          updateSessionUsage(ctx, sessionId, { contextPct: event.percentage });
          patchConversation(ctx, conversationId, { contextPct: event.percentage });
        });
        return;
      case 'consumed':
        sink.consumed(event.uuids);
        return;
      case 'turn_complete':
        // What streamed with no `message` to finish it is kept, so no turn end loses text.
        items.turnEnded({
          cut: (event.result ?? 'success') !== 'success',
          then: (ctx) => {
            updateSessionUsage(ctx, sessionId, {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cachedTokens: event.cachedTokens,
              costUsd: event.costUsd,
            });
          },
        });
        sink.turnComplete(event);
        return;
      case 'rate_limit':
        if (event.status === 'rejected') sink.rateLimited(event.resetsAt);
        return;
      case 'ended':
        sink.ended(event);
        return;
      // A turn's text is in its `message` events; a conversation keeps none of these.
      case 'activity':
      case 'compacted':
      case 'judge_denied':
        return;
    }
  };

  const done = (async () => {
    try {
      for await (const event of deps.handle.events) {
        try {
          onEvent(event);
        } catch (error) {
          deps.log.error({ err: error, conversationId }, 'an explore session event failed');
        }
      }
    } catch (error) {
      deps.log.error({ err: error, conversationId }, 'explore session events failed');
    } finally {
      items.dispose();
    }
  })();

  return {
    sessionId,
    handle: deps.handle,
    launch: deps.launch,
    buffers: items.buffers,
    fresh: deps.fresh,
    commands: () => commands,
    backgroundTasks: () => backgroundTasks,
    detach() {
      detached = true;
    },
    skipTurn() {
      skipping += 1;
    },
    storePartial: () => items.storePartial(),
    newTurn() {
      items.newTurn();
    },
    done,
  };
}
