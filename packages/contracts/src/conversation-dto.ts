import { z } from 'zod';
import { AgentCapabilitiesDto } from './agent-capabilities';
import {
  ConversationItemAuthor,
  ConversationOwnerKind,
  ConversationState,
  ShapeEventKind,
  TurnMarker,
} from './conversation';
import {
  ConversationFileId,
  ConversationId,
  ConversationItemId,
  InboxItemId,
  PassTurnId,
} from './ids';
import { FolderWhileHeldInput } from './folder-hold';
import { Effort } from './states';
import { ToolCallView } from './tool-call-view';

// Sessions spec §10: a conversation as the UI reads it, its stored items, what is streaming now, and
// the live frame the event socket carries, which is never stored and never takes a replay seq.

const Timestamp = z.iso.datetime();

/** A slash command the agent offers in its session. */
export const AgentCommandDto = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string().nullable(),
});
export type AgentCommandDto = z.infer<typeof AgentCommandDto>;

export const ConversationDto = z.object({
  id: ConversationId,
  owner: z.object({ kind: z.enum(ConversationOwnerKind), id: z.string() }),
  state: z.enum(ConversationState),
  capabilities: AgentCapabilitiesDto,
  model: z.string().nullable(),
  /** A chat's effort; null runs the model's own default, and for a Plan the effort is on the Plan. */
  effort: z.enum(Effort).nullable(),
  contextPct: z.number().nullable(),
  /** The turn starters waiting in the queue. */
  queued: z.int().nonnegative(),
  /** The sum of the conversation's sessions' dollars; null unless `capabilities.costUsd`. */
  costUsd: z.number().nonnegative().nullable(),
  /** An open "Send now" line waits. */
  sendNow: z.boolean(),
  /** A paused account's reset, null when it waits on the account. */
  pausedUntil: Timestamp.nullable(),
  /** The commands the agent last listed, kept so a cold conversation still offers `/`; null before any. */
  commands: z.array(AgentCommandDto).nullable(),
});
export type ConversationDto = z.infer<typeof ConversationDto>;

const ItemCommon = {
  id: ConversationItemId,
  conversationId: ConversationId,
  seq: z.int().positive(),
  author: z.enum(ConversationItemAuthor),
  partial: z.boolean(),
  /** More of it is on disk than the item holds: a call's whole output, a patch or a long text. */
  hasFull: z.boolean(),
  deliveredAt: Timestamp.nullable(),
  createdAt: Timestamp,
  /** The pass turn a task's item started or answers; absent outside a pass's turns. */
  turnId: PassTurnId.optional(),
};

/** A picture or file the builder sent with a message. */
export const ConversationFileDto = z.object({
  id: ConversationFileId,
  name: z.string(),
  mediaType: z.string(),
  size: z.int().nonnegative(),
});
export type ConversationFileDto = z.infer<typeof ConversationFileDto>;

/** What a task's notice offers: Send to Agent, or Allow This for a call auto mode denied. */
export const NoticeOffer = z.enum(['send_to_agent', 'allow_this']);
export type NoticeOffer = z.infer<typeof NoticeOffer>;

const TextKind = (kind: 'agent_message' | 'reasoning' | 'digest') =>
  z.object({ ...ItemCommon, kind: z.literal(kind), text: z.string() });

export const ConversationItemDto = z.discriminatedUnion('kind', [
  z.object({
    ...ItemCommon,
    kind: z.literal('message'),
    text: z.string(),
    /** The paths the message's `@` mentions name; none for a message without. */
    mentions: z.array(z.string()).default([]),
    /** The pictures sent with it; absent for a message without. */
    files: z.array(ConversationFileDto).optional(),
  }),
  TextKind('agent_message'),
  TextKind('reasoning'),
  TextKind('digest'),
  z.object({
    ...ItemCommon,
    kind: z.literal('notice'),
    text: z.string(),
    /** Set on the notice that the model changed: its display name and id. */
    change: z.object({ label: z.string(), model: z.string() }).optional(),
    /** What a task's notice offers the builder to send; absent when it offers nothing. */
    offer: NoticeOffer.optional(),
  }),
  z.object({ ...ItemCommon, kind: z.literal('tool_call'), call: ToolCallView }),
  z.object({ ...ItemCommon, kind: z.literal('card'), inboxItemId: InboxItemId }),
  z.object({
    ...ItemCommon,
    kind: z.literal('plan'),
    steps: z.array(
      z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
    ),
  }),
  z.object({
    ...ItemCommon,
    kind: z.literal('shape_event'),
    event: z.enum(ShapeEventKind),
    text: z.string(),
  }),
  z.object({
    ...ItemCommon,
    kind: z.literal('turn_marker'),
    marker: z.enum(TurnMarker),
    resolvedAt: Timestamp.nullable(),
  }),
]);
export type ConversationItemDto = z.infer<typeof ConversationItemDto>;

/** A page of items in `seq` order; `nextAfterSeq` reads the next page, null at the end. */
export const ConversationItemsPage = z.object({
  items: z.array(ConversationItemDto),
  nextAfterSeq: z.int().nullable(),
});
export type ConversationItemsPage = z.infer<typeof ConversationItemsPage>;

/** The most items one page holds. */
export const CONVERSATION_PAGE_ITEMS = 200;

export const LiveItemDto = z.discriminatedUnion('kind', [
  z.object({
    itemId: ConversationItemId,
    kind: z.enum(['agent_message', 'reasoning']),
    text: z.string(),
  }),
  z.object({
    itemId: ConversationItemId,
    kind: z.literal('tool_call'),
    call: ToolCallView,
    /** The output's tail, and the absolute offset it starts at. */
    output: z.string(),
    outputOffset: z.int().nonnegative(),
  }),
]);
export type LiveItemDto = z.infer<typeof LiveItemDto>;

/** What a conversation is streaming now, for a client that joins or reconnects. */
export const ConversationLiveDto = z.object({
  conversationId: ConversationId,
  items: z.array(LiveItemDto),
  /** A chat's message waits for Your folder to free. */
  waitingForFolder: z.boolean(),
});
export type ConversationLiveDto = z.infer<typeof ConversationLiveDto>;

/**
 * One coalesced change to an item in flight. `offset` is absolute: a text's length before `text`, or a
 * call's output length before `callPatch.output`.
 */
export const ConversationDeltaFrame = z.object({
  live: z.literal(true),
  type: z.literal('conversation.delta'),
  conversationId: ConversationId,
  itemId: ConversationItemId,
  kind: z.enum(['agent_message', 'reasoning', 'tool_call']),
  offset: z.int().nonnegative(),
  text: z.string().optional(),
  callPatch: z.object({ view: ToolCallView.optional(), output: z.string().optional() }).optional(),
});
export type ConversationDeltaFrame = z.infer<typeof ConversationDeltaFrame>;

/** What an item keeps on disk past what it holds; each null when it has none. */
export const ConversationFullDto = z.object({
  output: z.string().nullable(),
  patch: z.string().nullable(),
  text: z.string().nullable(),
});
export type ConversationFullDto = z.infer<typeof ConversationFullDto>;

/** Most characters of one `@` mention's path. */
export const MENTION_PATH_MAX = 1_024;

/** A path an `@` mention names: relative to the checkout, never climbing out of it. */
export const MentionPath = z
  .string()
  .min(1)
  .max(MENTION_PATH_MAX)
  .refine((p) => !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..'), {
    message: 'A mention names a path inside the checkout',
  });

/**
 * A builder message's text and the paths its `@` mentions name (the `@path` stays in the text); its
 * pictures travel as multipart parts, as a thread message's do.
 */
export const PostConversationMessage = z.object({
  text: z.string(),
  mentions: z.array(MentionPath).default([]),
  /** What a chat's send does when Your folder is held: absent reads only. */
  folder: FolderWhileHeldInput.optional(),
});
export type PostConversationMessage = z.infer<typeof PostConversationMessage>;
