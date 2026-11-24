import type { SlackChannelDto, SlackMemberDto } from '@10db/contracts';
import type { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { SlackBlock, SlackMetadata } from './blocks';
import { SlackError } from './errors';
import {
  AuthTestReply,
  ChannelOpenReply,
  ChannelsReply,
  MembersReply,
  MessagesReply,
  PermalinkReply,
  PostReply,
  ReactionsReply,
  SlackEnvelope,
  SlackErrorCode,
  UploadUrlReply,
  UserInfoReply,
  type SlackIdentity,
  type SlackMessage,
  type SlackReaction,
} from './responses';
import { compareTs } from './timestamps';
import { SLACK_API } from './api-address';

/** A conversation read stops after this many pages; a handful of open sends never come near it. */
const MAX_PAGES = 20;
const GROUP_MIN = 2;
const GROUP_MAX = 8;
const MEMBERS_PAGE_SIZE = 200;
const CHANNELS_PAGE_SIZE = 200;

export interface SlackClientDeps {
  readonly fetch: typeof fetch;
  /** The bot token, read when a call needs it and never kept; null when none is stored. */
  readonly token: () => Promise<string | null>;
  readonly clock: Clock;
  /** How long one call may take, on `clock`, before it fails as `timeout`. */
  readonly timeoutMs: number;
}

interface SlackPostInput {
  readonly channel: string;
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
  readonly threadTs?: string;
  readonly metadata?: SlackMetadata;
}

/** One file of an upload: its name in the message and its bytes. */
export interface SlackUploadFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface SlackMemberPage {
  readonly members: SlackMemberDto[];
  readonly nextCursor: string | null;
}

/** The Slack Web API calls 10db makes. Channel ids are kept as Slack returns them. */
export interface SlackClient {
  authTest(): Promise<SlackIdentity>;
  /** One page of the workspace's people: not deleted, not bots, not members of another team. */
  listMembers(cursor?: string): Promise<SlackMemberPage>;
  openDm(userId: string): Promise<string>;
  /** A group DM with 2 to 8 people besides the bot. */
  openGroup(userIds: readonly string[]): Promise<string>;
  post(input: SlackPostInput): Promise<{ ts: string }>;
  permalink(channel: string, ts: string): Promise<string>;
  /** A thread from `oldest` on, oldest first; the parent message comes first. */
  replies(channel: string, threadTs: string, oldest: string): Promise<SlackMessage[]>;
  /** The conversation's top-level messages from `oldest` on, oldest first. */
  history(channel: string, oldest: string): Promise<SlackMessage[]>;
  reactions(channel: string, ts: string): Promise<SlackReaction[]>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  /** The name of a person, for someone brought into a conversation. */
  userInfo(userId: string): Promise<string>;
  /** Every public channel and every private channel the bot is in, archived ones left out. */
  listChannels(): Promise<SlackChannelDto[]>;
  /** The bot joins a public channel. */
  joinChannel(channelId: string): Promise<void>;
  /** One message in the channel carrying every file: each is sent to Slack's upload address, then completed together. */
  uploadFiles(input: {
    readonly channelId: string;
    readonly comment: string;
    readonly files: readonly SlackUploadFile[];
  }): Promise<void>;
}

type Request =
  | { readonly kind: 'read'; readonly query: Readonly<Record<string, string>> }
  | { readonly kind: 'write'; readonly body: unknown };

/** The seconds a 429 asks for, when the header holds a positive whole number. */
function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function createSlackClient(deps: SlackClientDeps): SlackClient {
  /** One round trip, bounded by the injected clock. Resolves to the parsed JSON body of an `ok` reply. */
  async function exchange(method: string, request: Request, token: string, signal: AbortSignal) {
    let response: Response;
    try {
      const url = new URL(`${SLACK_API}/${method}`);
      if (request.kind === 'read') {
        for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
      }
      response = await deps.fetch(url, {
        method: request.kind === 'read' ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(request.kind === 'write'
            ? { 'Content-Type': 'application/json; charset=utf-8' }
            : {}),
        },
        ...(request.kind === 'write' ? { body: JSON.stringify(request.body) } : {}),
        signal,
      });
    } catch {
      // The failure's own message can repeat the request, headers included.
      throw new SlackError(method, 'unreachable');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.status === 429)
        throw new SlackError(
          method,
          'ratelimited',
          retryAfter(response.headers.get('Retry-After')),
        );
      throw new SlackError(method, response.ok ? 'bad_reply' : `http_${String(response.status)}`);
    }
    if (response.status === 429)
      throw new SlackError(method, 'ratelimited', retryAfter(response.headers.get('Retry-After')));
    if (!response.ok) throw new SlackError(method, `http_${String(response.status)}`);
    const envelope = SlackEnvelope.safeParse(body);
    if (!envelope.success) throw new SlackError(method, 'bad_reply');
    if (!envelope.data.ok) {
      const code = SlackErrorCode.safeParse(envelope.data.error);
      throw new SlackError(method, code.success ? code.data : 'bad_reply');
    }
    return body;
  }

  /** Runs `work` bounded by the injected clock: past `timeoutMs` its signal aborts and it fails as `timeout`. */
  async function bounded<T>(method: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const pending: { timer: Timer | null } = { timer: null };
    const timedOut = new Promise<never>((_resolve, reject) => {
      pending.timer = deps.clock.setTimeout(() => {
        controller.abort();
        reject(new SlackError(method, 'timeout'));
      }, deps.timeoutMs);
    });
    try {
      return await Promise.race([work(controller.signal), timedOut]);
    } finally {
      pending.timer?.cancel();
    }
  }

  async function call<S extends z.ZodType>(
    method: string,
    request: Request,
    schema: S,
  ): Promise<z.output<S>> {
    const token = await deps.token();
    if (token === null || token === '') throw new SlackError(method, 'no_token');
    const body = await bounded(method, (signal) => exchange(method, request, token, signal));
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new SlackError(method, 'bad_reply');
    return parsed.data;
  }

  /** Sends a file's bytes to the address Slack gave for it: no token, and no envelope in the answer. */
  async function sendBytes(uploadUrl: string, file: SlackUploadFile): Promise<void> {
    const method = 'files.upload';
    await bounded(method, async (signal) => {
      let response: Response;
      try {
        response = await deps.fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.bytes,
          signal,
        });
      } catch {
        throw new SlackError(method, 'unreachable');
      }
      if (response.status === 429)
        throw new SlackError(
          method,
          'ratelimited',
          retryAfter(response.headers.get('Retry-After')),
        );
      if (!response.ok) throw new SlackError(method, `http_${String(response.status)}`);
    });
  }

  const read = <S extends z.ZodType>(method: string, query: Record<string, string>, schema: S) =>
    call(method, { kind: 'read', query }, schema);
  const write = <S extends z.ZodType>(method: string, body: unknown, schema: S) =>
    call(method, { kind: 'write', body }, schema);

  /** Every page of a message read, oldest first. */
  async function messages(method: string, query: Record<string, string>): Promise<SlackMessage[]> {
    const all: SlackMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const reply: z.output<typeof MessagesReply> = await read(
        method,
        { ...query, include_all_metadata: 'true', ...(cursor === null ? {} : { cursor }) },
        MessagesReply,
      );
      all.push(...reply.messages);
      cursor = reply.nextCursor;
      if (cursor === null) break;
    }
    return all.sort((a, b) => compareTs(a.ts, b.ts));
  }

  async function authTest(): Promise<SlackIdentity> {
    const reply = await write('auth.test', {}, AuthTestReply);
    return {
      teamId: reply.team_id,
      teamName: reply.team,
      botUserId: reply.user_id,
      botName: reply.user,
    };
  }

  async function listChannels(): Promise<SlackChannelDto[]> {
    const all: SlackChannelDto[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const reply: z.output<typeof ChannelsReply> = await read(
        'conversations.list',
        {
          types: 'public_channel,private_channel',
          exclude_archived: 'true',
          limit: String(CHANNELS_PAGE_SIZE),
          ...(cursor === null ? {} : { cursor }),
        },
        ChannelsReply,
      );
      all.push(...reply.channels);
      cursor = reply.nextCursor;
      if (cursor === null) break;
    }
    return all;
  }

  async function uploadFiles(input: {
    readonly channelId: string;
    readonly comment: string;
    readonly files: readonly SlackUploadFile[];
  }): Promise<void> {
    const ids: { id: string; title: string }[] = [];
    for (const file of input.files) {
      // Slack takes this call's arguments in the query, not as JSON.
      const slot = await read(
        'files.getUploadURLExternal',
        { filename: file.name, length: String(file.bytes.byteLength) },
        UploadUrlReply,
      );
      await sendBytes(slot.upload_url, file);
      ids.push({ id: slot.file_id, title: file.name });
    }
    await write(
      'files.completeUploadExternal',
      { files: ids, channel_id: input.channelId, initial_comment: input.comment },
      SlackEnvelope,
    );
  }

  return {
    authTest,
    listChannels,
    uploadFiles,

    joinChannel: async (channelId) => {
      await write('conversations.join', { channel: channelId }, SlackEnvelope);
    },

    async listMembers(cursor) {
      const identity = await authTest();
      const reply = await read(
        'users.list',
        { limit: String(MEMBERS_PAGE_SIZE), ...(cursor === undefined ? {} : { cursor }) },
        MembersReply,
      );
      return {
        members: reply.members
          .filter((m) => !m.deleted && !m.bot && m.teamId === identity.teamId)
          .map((m) => m.member),
        nextCursor: reply.nextCursor,
      };
    },

    openDm: async (userId) => {
      const reply = await write('conversations.open', { users: userId }, ChannelOpenReply);
      return reply.channel.id;
    },

    openGroup: async (userIds) => {
      if (userIds.length < GROUP_MIN || userIds.length > GROUP_MAX)
        throw new SlackError('conversations.open', 'invalid_arguments');
      const reply = await write(
        'conversations.open',
        { users: userIds.join(',') },
        ChannelOpenReply,
      );
      return reply.channel.id;
    },

    post: async (input) => {
      const reply = await write(
        'chat.postMessage',
        {
          channel: input.channel,
          text: input.text,
          blocks: input.blocks,
          ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
          ...(input.metadata === undefined
            ? {}
            : {
                metadata: {
                  event_type: input.metadata.eventType,
                  event_payload: input.metadata.eventPayload,
                },
              }),
          unfurl_links: false,
          unfurl_media: false,
        },
        PostReply,
      );
      return { ts: reply.ts };
    },

    permalink: async (channel, ts) => {
      const reply = await read('chat.getPermalink', { channel, message_ts: ts }, PermalinkReply);
      return reply.permalink;
    },

    replies: (channel, threadTs, oldest) =>
      messages('conversations.replies', { channel, ts: threadTs, oldest }),

    history: (channel, oldest) => messages('conversations.history', { channel, oldest }),

    reactions: (channel, ts) =>
      read('reactions.get', { channel, timestamp: ts, full: 'true' }, ReactionsReply),

    addReaction: async (channel, ts, name) => {
      await write('reactions.add', { channel, timestamp: ts, name }, SlackEnvelope);
    },

    userInfo: (userId) => read('users.info', { user: userId }, UserInfoReply),
  };
}
