import { z } from 'zod';
import { InvalidError } from './errors';
import { InboxItemId } from './ids';
import { ToolCallView } from './tool-call-view';

// Sessions spec docs/superpowers/specs/2026-11-11-10db-sessions-design.md §6.2, §6.7, §9.1: a
// conversation (a chat's, a Plan's or a task's) and the items its transcript holds.

type ValueOf<T> = T[keyof T];

const Timestamp = z.iso.datetime();

/** What a conversation belongs to. */
export const ConversationOwnerKind = { Chat: 'chat', Shape: 'shape', Task: 'task' } as const;
export type ConversationOwnerKind = ValueOf<typeof ConversationOwnerKind>;

/** Which session profile a conversation runs: a read-only explore session, or a task's lane. */
export const ConversationProfile = { Explore: 'explore', Lane: 'lane' } as const;
export type ConversationProfile = ValueOf<typeof ConversationProfile>;

/** An explore conversation's state (§6.7). A task's conversation has none: its state is the runner's. */
export const ConversationState = {
  IdleCold: 'idle_cold',
  IdleWarm: 'idle_warm',
  Starting: 'starting',
  Running: 'running',
  WaitingCard: 'waiting_card',
  Stopping: 'stopping',
  TakenOver: 'taken_over',
  PausedAccount: 'paused_account',
  EndedError: 'ended_error',
  Sealed: 'sealed',
} as const;
export type ConversationState = ValueOf<typeof ConversationState>;

export const ConversationItemAuthor = {
  Builder: 'builder',
  Agent: 'agent',
  System: 'system',
} as const;
export type ConversationItemAuthor = ValueOf<typeof ConversationItemAuthor>;

/** What a transcript item is (§6.2). */
export const ConversationItemKind = {
  Message: 'message',
  AgentMessage: 'agent_message',
  Reasoning: 'reasoning',
  ToolCall: 'tool_call',
  Notice: 'notice',
  Digest: 'digest',
  Card: 'card',
  Plan: 'plan',
  /** A Plan row with no other kind: a proposal, a rehearsal, an edit, an engine event or a screen. */
  ShapeEvent: 'shape_event',
  TurnMarker: 'turn_marker',
} as const;
export type ConversationItemKind = ValueOf<typeof ConversationItemKind>;

/** A mark in the transcript that waits on the builder: "Send now" after a restart left messages queued. */
export const TurnMarker = { SendNow: 'send_now' } as const;
export type TurnMarker = ValueOf<typeof TurnMarker>;

/** The Plan row kinds a `shape_event` keeps in its body. */
export const ShapeEventKind = {
  Propose: 'propose',
  Rehearse: 'rehearse',
  Edit: 'edit',
  Event: 'event',
  Screen: 'screen',
} as const;
export type ShapeEventKind = ValueOf<typeof ShapeEventKind>;

const TextBody = z.object({ text: z.string() });

/** Each item kind's body, as it is stored in `conversation_items.body`. */
export const ConversationItemBody = {
  message: TextBody,
  agent_message: TextBody,
  reasoning: TextBody,
  tool_call: ToolCallView,
  notice: TextBody,
  digest: TextBody,
  card: z.object({ inboxItemId: InboxItemId }),
  plan: z.object({
    steps: z.array(
      z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
    ),
  }),
  shape_event: z.object({ kind: z.enum(ShapeEventKind), text: z.string() }),
  turn_marker: z.object({ marker: z.enum(TurnMarker), resolvedAt: Timestamp.nullable() }),
} as const satisfies Record<ConversationItemKind, z.ZodType>;
export type ConversationItemBody = {
  [K in ConversationItemKind]: z.infer<(typeof ConversationItemBody)[K]>;
};

/** An item's body read as its kind's; throws `InvalidError` naming the kind when it isn't one. */
export function parseItemBody<K extends ConversationItemKind>(
  kind: K,
  json: unknown,
): ConversationItemBody[K] {
  const parsed = ConversationItemBody[kind].safeParse(json);
  if (!parsed.success) throw new InvalidError(`not a ${kind} item body`);
  // The schema for K has just accepted the value, so the cast is the boundary.
  return parsed.data as ConversationItemBody[K];
}
