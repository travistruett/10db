import { z } from 'zod';
import type { SlackMemberDto } from '@10db/contracts';

/** A reaction on a message: its name and the user ids that added it. */
export interface SlackReaction {
  readonly name: string;
  readonly users: readonly string[];
}

/** A message as 10db reads it from Slack, whatever call returned it. */
export interface SlackMessage {
  readonly ts: string;
  /** The thread a reply belongs to; null for a message typed at the top of a conversation. */
  readonly threadTs: string | null;
  readonly user: string | null;
  readonly botId: string | null;
  readonly subtype: string | null;
  readonly text: string;
  /** Slack marked it edited; the text is its latest. */
  readonly edited: boolean;
  readonly reactions: readonly SlackReaction[];
  readonly metadata: {
    readonly eventType: string;
    readonly eventPayload: Readonly<Record<string, unknown>>;
  } | null;
}

export interface SlackIdentity {
  readonly teamId: string;
  readonly teamName: string;
  readonly botUserId: string;
}

/** Every Slack answer carries `ok`; a failure carries Slack's `error` word and nothing else 10db reads. */
export const SlackEnvelope = z.object({ ok: z.boolean(), error: z.string().optional() });

/** A Slack error word is lowercase words and underscores; anything else is not repeated anywhere. */
export const SlackErrorCode = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const AuthTestReply = z.object({
  team_id: z.string(),
  team: z.string(),
  user_id: z.string(),
});

export const ChannelOpenReply = z.object({ channel: z.object({ id: z.string().min(1) }) });

export const PostReply = z.object({ ts: z.string().min(1) });

export const PermalinkReply = z.object({ permalink: z.string().min(1) });

const RawReaction = z.object({ name: z.string(), users: z.array(z.string()).default([]) });
export const ReactionList = z.array(RawReaction).default([]);

const RawMessage = z
  .object({
    ts: z.string().min(1),
    thread_ts: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string().default(''),
    edited: z.unknown().optional(),
    reactions: ReactionList,
    metadata: z
      .object({ event_type: z.string(), event_payload: z.record(z.string(), z.unknown()) })
      .optional(),
  })
  .transform((m): SlackMessage => ({
    ts: m.ts,
    threadTs: m.thread_ts ?? null,
    user: m.user ?? null,
    botId: m.bot_id ?? null,
    subtype: m.subtype ?? null,
    text: m.text,
    edited: m.edited !== undefined,
    reactions: m.reactions.map((r) => ({ name: r.name, users: r.users })),
    metadata: m.metadata
      ? { eventType: m.metadata.event_type, eventPayload: m.metadata.event_payload }
      : null,
  }));

const NextCursor = z
  .object({ next_cursor: z.string().optional() })
  .optional()
  .transform((m) => (m?.next_cursor === undefined || m.next_cursor === '' ? null : m.next_cursor));

export const MessagesReply = z
  .object({ messages: z.array(RawMessage).default([]), response_metadata: NextCursor })
  .transform((r) => ({ messages: r.messages, nextCursor: r.response_metadata }));

export const ReactionsReply = z
  .object({ message: z.object({ reactions: ReactionList }).optional() })
  .transform((r) =>
    (r.message?.reactions ?? []).map((x): SlackReaction => ({ name: x.name, users: x.users })),
  );

const names = z.object({
  name: z.string().optional(),
  real_name: z.string().optional(),
  profile: z
    .object({ display_name: z.string().optional(), real_name: z.string().optional() })
    .optional(),
});

/** What a person is called: the display name they chose, else their real name, else their handle. */
function nameOf(user: z.infer<typeof names>): string {
  return (
    [user.profile?.display_name, user.real_name, user.profile?.real_name, user.name].find(
      (n): n is string => n !== undefined && n !== '',
    ) ?? ''
  );
}

export const UserInfoReply = z.object({ user: names }).transform((r): string => nameOf(r.user));

const RawMember = names.extend({
  id: z.string().min(1),
  team_id: z.string(),
  deleted: z.boolean().default(false),
  is_bot: z.boolean().default(false),
  profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
      title: z.string().optional(),
      email: z.string().optional(),
      image_72: z.string().optional(),
    })
    .default({}),
});

const orNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

export const MembersReply = z
  .object({ members: z.array(RawMember).default([]), response_metadata: NextCursor })
  .transform((r) => ({
    members: r.members.map((m) => ({
      userId: m.id,
      teamId: m.team_id,
      deleted: m.deleted,
      bot: m.is_bot || m.id === 'USLACKBOT',
      member: {
        userId: m.id,
        teamId: m.team_id,
        name: nameOf(m),
        realName: m.real_name ?? m.profile.real_name ?? nameOf(m),
        title: orNull(m.profile.title),
        email: orNull(m.profile.email),
        avatarUrl: orNull(m.profile.image_72),
      } satisfies SlackMemberDto,
    })),
    nextCursor: r.response_metadata,
  }));
