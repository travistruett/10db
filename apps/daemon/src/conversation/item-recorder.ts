import {
  ConversationItemAuthor,
  ConversationItemKind,
  mintId,
  ToolCallStatus,
  type ConversationId,
  type ConversationItemId,
  type PassTurnId,
  type ToolCallView,
} from '@10db/contracts';
import { putItem, type Json, type WriteContext } from '@10db/db';
import type { Clock } from '../clock';
import type { LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import type { SessionEvent, ToolCallFull } from '../sessions';
import { boundedOutput, capItemBody, writeFullOutput, type FullOutput } from './full-output';
import { createLiveBuffers, type LiveBuffers } from './live-buffers';
import { storePartial } from './partial';

// Sessions spec §6.3, §6.5: what one open session says, as a conversation's items, for every owner (the
// explore engine's sessions and a lane's). Its text and calls stream into live buffers, sent as live
// frames, and each finished item is stored under the id its buffer minted, capped, with what the cap or
// the view cut off on disk. A turn's end finishes what streamed and names its reply, so the turn's end
// attaches to that item rather than storing the reply again; a turn that ends early stores what
// streamed, marked partial, under the turn.

/** The session events that are a conversation's items. */
export type ItemEvent = Extract<
  SessionEvent,
  { type: 'text_delta' | 'reasoning_delta' | 'message' | 'tool_call' | 'plan_update' }
>;

export interface ItemRecorder {
  readonly buffers: LiveBuffers;
  /** Streams or stores one item event. */
  record(event: ItemEvent): void;
  /**
   * The turn ended: what it streamed is finished, in the caller's write, a reply with no `message` to
   * finish it included, which is kept partial when the turn was `cut` short (failed, stopped, out of
   * turns); `then` joins that write. Answers the turn's last finished reply, null when it had none.
   */
  turnEnded(opts?: {
    readonly cut?: boolean;
    readonly then?: (ctx: WriteContext) => void;
  }): ConversationItemId | null;
  /** Stores what streamed, marked partial, and empties the buffers. */
  storePartial(): ConversationItemId[];
  /** A turn begins: its plan is a new item. */
  newTurn(): void;
  /** Stops every pending frame. */
  dispose(): void;
}

export interface ItemRecorderDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly dataDir: string;
  readonly frames: LiveFrames;
  readonly conversationId: ConversationId;
  /** The pass turn each stored item belongs to, read as it is stored; null outside a pass's turns. */
  readonly turnId?: () => PassTurnId | null;
}

export function createItemRecorder(deps: ItemRecorderDeps): ItemRecorder {
  const { state, conversationId } = deps;
  const buffers = createLiveBuffers({
    conversationId,
    clock: deps.clock,
    send: (frame) => {
      deps.frames.publish(frame);
    },
  });
  /** The adapter ids of reasoning items in flight, stored when the next item begins. */
  const reasoning = new Set<string>();
  /** The adapter ids of replies streaming with no `message` yet, finished at the turn's end. */
  const replies = new Set<string>();
  /** The turn's last finished reply. */
  let lastReply: ConversationItemId | null = null;
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
    const turnId = deps.turnId?.() ?? null;
    putItem(ctx, conversationId, {
      id,
      author: ConversationItemAuthor.Agent,
      kind,
      body: capped.body,
      partial,
      ...(turnId === null ? {} : { turnId }),
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

  /** Stores the reasoning in flight, but `except`'s, as complete. */
  const storeReasoning = (ctx: WriteContext, except?: string): void => {
    for (const adapterId of [...reasoning]) {
      if (adapterId === except) continue;
      reasoning.delete(adapterId);
      const held = buffers.finish(adapterId);
      if (held?.kind !== 'reasoning' || held.text === '') continue;
      store(ctx, held.itemId, ConversationItemKind.Reasoning, { text: held.text }, null);
    }
  };

  /** Stores a reply; a finished one with text is the turn's last reply so far. */
  const storeReply = (ctx: WriteContext, id: ConversationItemId, text: string, partial = false) => {
    store(ctx, id, ConversationItemKind.AgentMessage, { text }, null, partial);
    if (!partial && text.trim() !== '') lastReply = id;
  };

  /** A new item begins: the reasoning before it is complete. */
  const nextItem = (adapterId: string): void => {
    if ([...reasoning].some((id) => id !== adapterId))
      write((ctx) => {
        storeReasoning(ctx, adapterId);
      });
  };

  const finishedCall = (call: ToolCallView, full: ToolCallFull | undefined): void => {
    const id = buffers.itemIdOf(call.id);
    buffers.finish(call.id);
    write((ctx) => {
      store(ctx, id, ConversationItemKind.ToolCall, { ...call }, full ?? null);
    });
  };

  return {
    buffers,
    record(event) {
      switch (event.type) {
        case 'text_delta':
          nextItem(event.itemId);
          replies.add(event.itemId);
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
          replies.delete(event.itemId);
          buffers.finish(event.itemId);
          write((ctx) => {
            storeReply(ctx, id, event.text);
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
              { steps: event.steps.map((s) => ({ text: s.text, status: s.status })) },
              null,
            );
          });
          return;
        }
      }
    },
    turnEnded({ cut = false, then } = {}) {
      write((ctx) => {
        storeReasoning(ctx);
        for (const adapterId of [...replies]) {
          replies.delete(adapterId);
          const held = buffers.finish(adapterId);
          if (held?.kind === 'agent_message' && held.text !== '')
            storeReply(ctx, held.itemId, held.text, cut);
        }
        then?.(ctx);
      });
      const reply = lastReply;
      lastReply = null;
      return reply;
    },
    storePartial() {
      reasoning.clear();
      replies.clear();
      lastReply = null;
      const ids = write((ctx) =>
        storePartial(ctx, conversationId, buffers.inFlight(), {
          turnId: deps.turnId?.() ?? null,
          keep: (id, full) => {
            disk.push([id, full]);
          },
        }),
      );
      buffers.dispose();
      return ids;
    },
    newTurn() {
      planItem = null;
    },
    dispose() {
      buffers.dispose();
    },
  };
}
