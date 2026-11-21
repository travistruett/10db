import { z } from 'zod';
import { InvalidError } from './errors';
import { InboxItemId, TaskId } from './ids';
import { ToolCallView } from './tool-call-view';

// Sessions spec docs/superpowers/specs/2026-11-11-10db-sessions-design.md §6.2, §6.7, §9.1: a
// conversation (a chat's, a Plan's or a task's) and the items its transcript holds.

type ValueOf<T> = T[keyof T];

const Timestamp = z.iso.datetime();

/** What a conversation belongs to. */
export const ConversationOwnerKind = { Chat: 'chat', Task: 'task' } as const;
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
  Review: 'review',
  Edit: 'edit',
  Event: 'event',
  Screen: 'screen',
} as const;
export type ShapeEventKind = ValueOf<typeof ShapeEventKind>;

const TextBody = z.object({ text: z.string() });

/** A notice that the conversation's model changed: the model's display name and its id. */
export const ModelChangeNotice = z.object({
  kind: z.literal('model_change'),
  label: z.string(),
  model: z.string(),
});
export type ModelChangeNotice = z.infer<typeof ModelChangeNotice>;

/** A notice that Do It handed the chat's work to a task. */
export const HandedToNotice = z.object({
  kind: z.literal('handed_to'),
  taskId: TaskId,
  title: z.string(),
  place: z.enum(['worktree', 'here']),
});
export type HandedToNotice = z.infer<typeof HandedToNotice>;

/** What a notice reads as text: its own, the model change or the handover in words. */
export function noticeText(body: { text: string } | ModelChangeNotice | HandedToNotice): string {
  if ('text' in body) return body.text;
  if (body.kind === 'handed_to')
    return body.place === 'here'
      ? `Handed to the pass ‘${body.title}’ in Your folder`
      : `Handed to the task ‘${body.title}’ in its own copy`;
  return `Now on ${body.label} · ${body.model}`;
}

/** Each item kind's body, as it is stored in `conversation_items.body`. */
export const ConversationItemBody = {
  /** A builder's message, with the paths its `@` mentions name (the `@path` stays in the text). */
  message: z.object({
    text: z.string(),
    mentions: z.array(z.string()).optional(),
    /** Set on the request that asks the agent for a task's brief, which no digest or brief repeats; `carry_on` marks the message that resumes a turn after the builder's choice. */
    purpose: z.enum(['brief', 'carry_on']).optional(),
  }),
  agent_message: TextBody,
  reasoning: TextBody,
  tool_call: ToolCallView,
  notice: z.union([TextBody, ModelChangeNotice, HandedToNotice]),
  digest: TextBody,
  card: z.object({ inboxItemId: InboxItemId }),
  plan: z.object({
    steps: z.array(
      z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
    ),
  }),
  shape_event: z.object({
    kind: z.enum(ShapeEventKind),
    text: z.string(),
    /** What the press asks the session to do: a Propose or Rehearse is a turn starter (queued). */
    prompt: z.string().optional(),
    /** The same ask for a session with no subagents, which does the review itself; absent, `prompt` serves every session. */
    promptInSession: z.string().optional(),
    /** The tasks a Rehearse turn rehearses, each with the hash it was proposed at. */
    rehearsing: z.array(z.object({ taskKey: z.string(), hash: z.string() })).optional(),
  }),
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
