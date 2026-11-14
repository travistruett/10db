import {
  ConversationItemAuthor,
  ConversationItemKind,
  EventType,
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
import { boundedOutput, capItemBody, writeFullOutput, type FullOutput } from './full-output';
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
  /** Stores what streamed, marked partial, and empties the buffers. */
  storePartial(): ConversationItemId[];
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

  /** What a write left for the disk, put there once the write has committed. */
  let disk: [ConversationItemId, FullOutput][] = [];
  /** Runs `fn` in one write, then writes what its items keep on disk, outside the transaction. */
  const write = <T>(fn: (ctx: WriteContext) => T): T => {
    const value = state.write(fn);
    const pending = disk;
    disk = [];
    for (const [id, full] of pending)
      try {
        writeFullOutput(deps.dataDir, conversationId, id, full);
      } catch (error) {
        deps.log.warn({ err: error, conversationId }, 'an item’s full output could not be kept');
      }
    return value;
  };

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
    const output = full?.output;
    const onDisk: FullOutput = {
      ...capped.full,
      ...(full?.patch === undefined ? {} : { patch: full.patch }),
      ...(output === undefined ? {} : { output: boundedOutput(output) }),
    };
    if (Object.keys(onDisk).length > 0) disk.push([id, onDisk]);
  };

  /** Stores each text in flight: reasoning complete (call 10), a reply with no `message` partial. */
  const storeTexts = (ctx: WriteContext, except?: string, replies = false): void => {
    for (const adapterId of [...reasoning]) {
      if (adapterId === except) continue;
      reasoning.delete(adapterId);
      const held = buffers.finish(adapterId);
      if (held?.kind !== 'reasoning' || held.text === '') continue;
      store(ctx, held.itemId, ConversationItemKind.Reasoning, { text: held.text }, null);
    }
    if (!replies) return;
    for (const held of buffers.inFlight())
      if (held.kind === 'agent_message' && held.text !== '')
        store(ctx, held.itemId, ConversationItemKind.AgentMessage, { text: held.text }, null, true);
  };

  /** A new item begins: the reasoning before it is complete. */
  const nextItem = (adapterId: string): void => {
    if ([...reasoning].some((id) => id !== adapterId))
      write((ctx) => {
        storeTexts(ctx, adapterId);
      });
  };

  const finishedCall = (call: ToolCallView, full: ToolCallFull | undefined): void => {
    const id = buffers.itemIdOf(call.id);
    buffers.finish(call.id);
    write((ctx) => {
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
        write((ctx) => {
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
        write((ctx) => {
          store(
            ctx,
            id,
            ConversationItemKind.Plan,
            {
              steps: event.steps.map((s) => ({ text: s.text, status: s.status })),
            },
            null,
          );
        });
        return;
      }
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
        write((ctx) => {
          storeTexts(ctx, undefined, true);
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
    storePartial() {
      reasoning.clear();
      const ids = write((ctx) =>
        storePartial(ctx, conversationId, buffers.inFlight(), (id, full) => {
          disk.push([id, full]);
        }),
      );
      buffers.dispose();
      return ids;
    },
    newTurn() {
      planItem = null;
    },
    done,
  };
}
