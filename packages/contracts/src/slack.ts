import { z } from 'zod';
import { SECRET_CHARACTERS } from './accounts';
import { LinearReporterSettings } from './linear-posts';
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
  /** The workspace the send was drafted in; null only on a send migrated without one. */
  teamId: z.string().nullable(),
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
  heldBy: z.enum(['review', 'first_send', 'limit', 'scan', 'slack_off']).nullable(),
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

/** Failure codes a send records in `error`. */
export const SendFailure = {
  WorkspaceChanged: 'workspace_changed',
  BotChanged: 'bot_changed',
  NoWorkspace: 'no_workspace',
} as const;
export type SendFailure = (typeof SendFailure)[keyof typeof SendFailure];

/** `GET /slack/members`: the people of one signed-in workspace, optionally filtered. */
export const SlackMembersQuery = z.object({
  teamId: z.string().min(1),
  query: z.string().default(''),
});
export type SlackMembersQuery = z.infer<typeof SlackMembersQuery>;

/** A member of a signed-in workspace, offered when the builder adds a person. */
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
  /** Replaces that workspace's token, and refuses a token from another team. */
  teamId: z.string().min(1).optional(),
});
export type SlackTokenInput = z.infer<typeof SlackTokenInput>;

/** `GET /inbox/:id/compose`: the message a question would be for these people, and what the scan holds. */
export const ComposePreviewDto = z.object({ text: z.string(), hits: z.array(OutboundHit) });
export type ComposePreviewDto = z.infer<typeof ComposePreviewDto>;

/** One signed-in workspace; its bot token is in the Keychain under `slack-bot:<teamId>`. */
export const SlackWorkspace = z.strictObject({
  teamId: z.string().min(1),
  teamName: z.string(),
  /** The bot on record; absent until the first record (stored before this, or connected again). */
  botUserId: z.string().min(1).optional(),
  botName: z.string().min(1).optional(),
  /** When this bot was recorded: threads sent before it are never joined. */
  botSince: z.iso.datetime().optional(),
});
export type SlackWorkspace = z.infer<typeof SlackWorkspace>;

export const SlackWorkspaceState = {
  Checking: 'checking',
  Connected: 'connected',
  Refused: 'refused',
  Unreachable: 'unreachable',
  None: 'none',
} as const;
export type SlackWorkspaceState = (typeof SlackWorkspaceState)[keyof typeof SlackWorkspaceState];

/** One workspace as its watch last found it; never the token. `none`: its token is gone from the Keychain. */
export const SlackWorkspaceStatusDto = z.strictObject({
  teamId: z.string(),
  teamName: z.string(),
  botUserId: z.string().nullable(),
  botName: z.string().nullable(),
  state: z.enum(SlackWorkspaceState),
  checkedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type SlackWorkspaceStatusDto = z.infer<typeof SlackWorkspaceStatusDto>;

/** `GET /slack`: every signed-in workspace; `off` when the daemon runs with TENDB_SLACK=off. */
export const SlackStatusDto = z.strictObject({
  off: z.boolean(),
  workspaces: z.array(SlackWorkspaceStatusDto),
});
export type SlackStatusDto = z.infer<typeof SlackStatusDto>;

/** The `slack.workspaces` setting: every signed-in workspace. */
export const SlackWorkspaces = z.array(SlackWorkspace);
export type SlackWorkspaces = z.infer<typeof SlackWorkspaces>;

/** A project's `slack.<projectId>` setting: the workspace it sends through, or null for the builder's "off". */
export const ProjectSlackSetting = z.strictObject({ teamId: z.string().min(1).nullable() });
export type ProjectSlackSetting = z.infer<typeof ProjectSlackSetting>;

/** What Slack is for a project: its workspace, or nulls for Off, and how many of its questions are out now. */
export const ProjectSlackDto = z.strictObject({
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  /** Sends of the project's cards that are sending or sent: what a change of workspace takes back. */
  out: z.number().int().min(0),
});
export type ProjectSlackDto = z.infer<typeof ProjectSlackDto>;

/** `GET /projects/:projectId/integrations`: the GitHub login the project uses and its Slack workspace. */
export const ProjectIntegrationsDto = z.strictObject({
  github: z.strictObject({ login: z.string().nullable() }),
  slack: ProjectSlackDto,
  /** The project's Linear reporter settings, and why it does not report now (null when it does). */
  linear: LinearReporterSettings.extend({ blockedBy: z.string().nullable() }),
});
export type ProjectIntegrationsDto = z.infer<typeof ProjectIntegrationsDto>;

/** `PUT /projects/:projectId/integrations`: the workspace the project sends through, or null for off. */
export const ProjectIntegrationsInput = z.strictObject({
  slack: ProjectSlackSetting,
});
export type ProjectIntegrationsInput = z.infer<typeof ProjectIntegrationsInput>;

/** A channel the bot can name in a post: public ones it may join, private ones it is already in. */
export const SlackChannelDto = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  isPrivate: z.boolean(),
  /** Whether the bot is in it now; a public channel it is not in is joined at the first post. */
  isMember: z.boolean(),
});
export type SlackChannelDto = z.infer<typeof SlackChannelDto>;

/** `GET /projects/:projectId/slack/channels`: the channels of the project's workspace, or why they can't be read. */
export const SlackChannelsDto = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), channels: z.array(SlackChannelDto) }),
  /** The bot token lacks `channels:read` or `groups:read`: add the scopes, reinstall, Replace Token. */
  z.strictObject({ state: z.literal('missing_scope') }),
]);
export type SlackChannelsDto = z.infer<typeof SlackChannelsDto>;

/**
 * A project's `slack-sharing.<projectId>` setting and `GET /projects/:projectId/slack-sharing`: whether
 * a pass's pictures are posted to a channel, and the channel with the workspace it belongs to.
 */
export const ProjectSlackSharingDto = z.strictObject({
  enabled: z.boolean(),
  teamId: z.string().min(1).nullable(),
  channelId: z.string().min(1).nullable(),
  channelName: z.string().nullable(),
  /** When the switch was turned on, which tasks' pictures are posted from; absent on a setting saved before it. */
  enabledAt: z.string().nullable().optional(),
});
export type ProjectSlackSharingDto = z.infer<typeof ProjectSlackSharingDto>;

/** `PUT /projects/:projectId/slack-sharing`: the switch and the channel, in the project's own workspace. */
export const ProjectSlackSharingInput = z.strictObject({
  enabled: z.boolean(),
  channelId: z.string().min(1).nullable(),
  channelName: z.string().nullable(),
});
export type ProjectSlackSharingInput = z.infer<typeof ProjectSlackSharingInput>;
