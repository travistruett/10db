import { z } from 'zod';
import { SECRET_CHARACTERS } from './accounts';
import { GoalId, InboxItemId, PersonId, StakeholderSendId, TaskId } from './ids';
import { QuestionCategory, SendState } from './states';
import { PersonDto } from './team';

/** A line the outbound scan found in a drafted message; a hold stops the send until the builder says go. */
export const OutboundHit = z.object({
  pattern: z.string(),
  line: z.int(),
  severity: z.enum(['hold', 'warn']),
});
export type OutboundHit = z.infer<typeof OutboundHit>;

export const SendPersonDto = z.object({
  personId: PersonId.nullable(),
  /** The Slack user id, kept so a person who left the list is still named in the conversation. */
  userId: z.string(),
  name: z.string(),
  /** A recipient's reply or approval can answer the card; anyone else in the conversation only talks. */
  recipient: z.boolean(),
});
export type SendPersonDto = z.infer<typeof SendPersonDto>;

const ConversationMessage = z.object({
  userId: z.string(),
  name: z.string(),
  text: z.string(),
  ts: z.string(),
});

export const StakeholderSendDto = z.object({
  id: StakeholderSendId,
  inboxItemId: InboxItemId,
  state: z.enum(SendState),
  people: z.array(SendPersonDto),
  text: z.string(),
  hits: z.array(OutboundHit),
  permalink: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  remindedAt: z.iso.datetime().nullable(),
  answeredAt: z.iso.datetime().nullable(),
  returnedAt: z.iso.datetime().nullable(),
  returnedReason: z.enum(['timer', 'disagreed']).nullable(),
  /** Why a draft waits for the builder. */
  heldBy: z.enum(['review', 'first_send', 'limit', 'scan']).nullable(),
  /** The option a settled conversation landed on, waiting for a recipient to approve it. */
  proposal: z.object({ choice: z.string(), confidence: z.number() }).nullable(),
  askedWhichWay: z.boolean(),
  conversation: z.array(ConversationMessage),
  reply: z.object({ text: z.string(), userId: z.string(), ts: z.string() }).nullable(),
  replyVia: z.enum(['thread', 'top_level']).nullable(),
  readAs: z.enum(['option', 'own_words', 'approved']).nullable(),
  answeredBy: PersonId.nullable(),
  error: z.string().nullable(),
});
export type StakeholderSendDto = z.infer<typeof StakeholderSendDto>;

/** The Slack connection as the daemon last saw it; never the token. */
export const SlackConnectionDto = z.object({
  state: z.enum(['off', 'none', 'connected', 'refused', 'unreachable']),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  botUserId: z.string().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type SlackConnectionDto = z.infer<typeof SlackConnectionDto>;

/** A member of the connected workspace, offered when the builder adds a person. */
export const SlackMemberDto = z.object({
  userId: z.string(),
  teamId: z.string(),
  name: z.string(),
  realName: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type SlackMemberDto = z.infer<typeof SlackMemberDto>;

/** `POST /inbox/:id/send`: Send, with the builder's edit if any. `overrideLimit` is Send Anyway. */
export const SendInput = z.object({
  text: z.string().min(1).max(3000).optional(),
  overrideLimit: z.boolean().optional(),
});
export type SendInput = z.infer<typeof SendInput>;

/** `POST /inbox/:id/ask`: Ask Someone, with an optional standing rule for the same kind of question. */
export const AskSomeoneInput = z.object({
  personIds: z.array(PersonId).min(1).max(8),
  always: z
    .object({
      categories: z.array(z.enum(QuestionCategory)),
      goalId: GoalId.nullable(),
      taskId: TaskId.nullable(),
    })
    .nullable(),
});
export type AskSomeoneInput = z.infer<typeof AskSomeoneInput>;

/** Who a kind of question goes to, and which scope's rule says so. */
export const QuestionRouteDto = z.object({
  category: z.enum(QuestionCategory).nullable(),
  topic: z.string().nullable(),
  people: z.array(PersonDto),
  from: z.enum(['task', 'goal', 'area', 'project', 'topic']),
});
export type QuestionRouteDto = z.infer<typeof QuestionRouteDto>;

/** `PUT /slack/token`. The token is checked with Slack before it is saved, and goes to the Keychain only. */
export const SlackTokenInput = z.strictObject({
  token: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(SECRET_CHARACTERS, 'printable ASCII with no spaces, double quotes or backslashes'),
});
export type SlackTokenInput = z.infer<typeof SlackTokenInput>;

/** `GET /inbox/:id/compose`: the message a question would be for these people, and what the scan holds. */
export const ComposePreviewDto = z.object({ text: z.string(), hits: z.array(OutboundHit) });
export type ComposePreviewDto = z.infer<typeof ComposePreviewDto>;
