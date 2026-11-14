import {
  ConversationItemAuthor,
  ConversationItemKind,
  mintId,
  ToolCallStatus,
  type ConversationId,
  type ConversationItemId,
  type SessionId,
  type ToolCallView,
} from '@10db/contracts';
import {
  markSessionStarted,
  patchConversation,
  putItem,
  updateSessionUsage,
  type Json,
  type WriteContext,
} from '@10db/db';
import type { Clock } from '../clock';
import type { LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import type { AgentCommand, SessionEvent, SessionHandle, ToolCallFull } from '../sessions';
import type { ExploreLaunch } from './explore-hooks';
import { capItemBody, writeFullOutput } from './full-output';
import { createLiveBuffers, type LiveBuffers } from './live-buffers';
import { storePartial } from './partial';

// Sessions spec §6.5, §6.6: one open explore session. Its events stream into live buffers, and each
// finished item is stored under the id its buffer minted (call 3), capped (call 31), with what the cap
// or the view cut off on disk. What the reducer needs (started, a turn's end, the session's end) goes
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
  /** The slash commands the session offers, for the composer (M5a). */
  readonly commands: () => readonly AgentCommand[];
  /** Reads no more events but `ended` (call 25). */
  detach(): void;
  /**
   * The running turn is over for the engine though its own events are still to come (a receipt settled
   * its stop): they are dropped, up to and including its `turn_complete` (call 25).
   */
  skipTurn(): void;
  /** Stores each reasoning item in flight, complete (call 10). */
  storeReasoning(write: WriteContext): void;
  /** Stores what streamed, marked partial, and empties the buffers. */
  storePartial(write: WriteContext): ConversationItemId[];
  /** A turn begins: its plan is a new item (call 11). */
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
  const buffers = createLiveBuffers({
    conversationId,
    clock: deps.clock,
    send: (frame) => {
      deps.frames.publish(frame);
    },
  });
  let detached = false;
  /** Turns whose remaining events are dropped, oldest first: each ends with its `turn_complete`. */
  let skipping = 0;
  let commands: readonly AgentCommand[] = [];
  /** The adapter ids of reasoning items in flight, stored when the next item begins. */
  const reasoning = new Set<string>();
  let planItem: ConversationItemId | null = null;

  const store = (
    ctx: WriteContext,
    id: ConversationItemId,
    kind: ConversationItemKind,
    body: Json,
    full: ToolCallFull | null,
    partial = false,
  ): void => {
    const capped = capItemBody(kind, body);
    putItem(ctx, conversationId, {
      id,
      author: ConversationItemAuthor.Agent,
      kind,
      body: capped.body,
      partial,
    });
    // The adapter's own output and patch are whole; the cap's text is what the item left out.
    writeFullOutput(deps.dataDir, conversationId, id, { ...capped.full, ...full });
  };

  const storeReasoning = (ctx: WriteContext, except?: string): void => {
    for (const adapterId of [...reasoning]) {
      if (adapterId === except) continue;
      reasoning.delete(adapterId);
      const held = buffers.finish(adapterId);
      if (held?.kind !== 'reasoning' || held.text === '') continue;
      store(ctx, held.itemId, ConversationItemKind.Reasoning, { text: held.text }, null);
    }
  };

  /** A new item begins: the reasoning before it is complete. */
  const nextItem = (adapterId: string): void => {
    if ([...reasoning].some((id) => id !== adapterId))
      state.write((ctx) => {
        storeReasoning(ctx, adapterId);
      });
  };

  const finishedCall = (call: ToolCallView, full: ToolCallFull | undefined): void => {
    const id = buffers.itemIdOf(call.id);
    buffers.finish(call.id);
    state.write((ctx) => {
      store(ctx, id, ConversationItemKind.ToolCall, { ...call }, full ?? null);
    });
  };

  const onEvent = (event: SessionEvent): void => {
    if (detached && event.type !== 'ended') return;
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
        nextItem(event.itemId);
        buffers.text(event.itemId, 'agent_message', event.offset, event.text);
        return;
      case 'reasoning_delta':
        nextItem(event.itemId);
        reasoning.add(event.itemId);
        buffers.text(event.itemId, 'reasoning', event.offset, event.text);
        return;
      case 'message': {
        nextItem(event.itemId);
        const id = buffers.itemIdOf(event.itemId);
        buffers.finish(event.itemId);
        state.write((ctx) => {
          store(ctx, id, ConversationItemKind.AgentMessage, { text: event.text }, null);
        });
        return;
      }
      case 'tool_call':
        nextItem(event.call.id);
        buffers.call(event.call, event.appended);
        if (event.call.status !== ToolCallStatus.Running) finishedCall(event.call, event.full);
        return;
      case 'plan_update': {
        const id = (planItem ??= mintId('ConversationItem'));
        state.write((ctx) => {
          putItem(ctx, conversationId, {
            id,
            author: ConversationItemAuthor.Agent,
            kind: ConversationItemKind.Plan,
            body: { steps: event.steps.map((s) => ({ text: s.text, status: s.status })) },
          });
        });
        return;
      }
      case 'commands':
        commands = event.commands;
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
        state.write((ctx) => {
          storeReasoning(ctx);
          updateSessionUsage(ctx, sessionId, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cachedTokens: event.cachedTokens,
            costUsd: event.costUsd,
          });
        });
        sink.turnComplete(event);
        return;
      case 'rate_limit':
        if (event.status === 'rejected') sink.rateLimited(event.resetsAt);
        return;
      case 'ended':
        sink.ended(event);
        return;
      // A turn's text is in its `message` events; the rest is for the lanes.
      case 'activity':
      case 'compacted':
      case 'background_tasks':
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
      buffers.dispose();
    }
  })();

  return {
    sessionId,
    handle: deps.handle,
    launch: deps.launch,
    buffers,
    fresh: deps.fresh,
    commands: () => commands,
    detach() {
      detached = true;
    },
    skipTurn() {
      skipping += 1;
    },
    storeReasoning: (ctx) => {
      storeReasoning(ctx);
    },
    storePartial(ctx) {
      reasoning.clear();
      const ids = storePartial(ctx, conversationId, buffers.inFlight());
      buffers.dispose();
      return ids;
    },
    newTurn() {
      planItem = null;
    },
    done,
  };
}
