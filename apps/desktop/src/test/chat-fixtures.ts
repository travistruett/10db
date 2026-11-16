import {
  ChatDto,
  ChatModelsDto,
  ChatPatchInput,
  ConversationItemDto,
  mintId,
  ProjectId,
  type ChatCreateInput,
  type ConversationId,
  type ProjectFileMatchDto,
  type SessionStartDto,
} from '@10db/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { daemonUrl } from './daemon';
import { folderDto } from './folder-fixtures';
import { builderItem, conversationDto } from './conversation-fixtures';

// Sessions fixtures. Every DTO is parsed with its contract, so a contract change breaks the fixture
// before it breaks a view, and `chatServer` answers the routes the daemon serves for chats.

const AT = '2026-11-13T09:00:00.000Z';

export function chatDto(
  overrides: Partial<Omit<ChatDto, 'conversation'>> & {
    readonly conversation?: Partial<ChatDto['conversation']>;
  } = {},
): ChatDto {
  const id = overrides.id ?? mintId('Chat');
  const { conversation = {}, ...rest } = overrides;
  const conversationId = rest.conversationId ?? mintId('Conversation');
  return ChatDto.parse({
    id,
    projectId: mintId('Project'),
    conversationId,
    conversation: conversationDto({
      id: conversationId,
      owner: { kind: 'chat', id },
      state: 'idle_warm',
      ...conversation,
    }),
    title: 'Login fails after sleep',
    titleSource: 'agent',
    mode: 'explore',
    taskId: null,
    passId: null,
    tabPosition: 0,
    createdAt: AT,
    lastActivityAt: AT,
    archivedAt: null,
    lastReplyAt: null,
    tasksFiled: 0,
    ...rest,
  });
}

/** A model list a Claude account offers. */
export function chatModelsDto(overrides: Partial<ChatModelsDto> = {}): ChatModelsDto {
  return ChatModelsDto.parse({
    default: 'claude-opus-5',
    offered: [
      { model: 'claude-opus-5', tier: 'frontier' },
      { model: 'claude-sonnet-5-5', tier: 'balanced' },
    ],
    webSearch: true,
    ...overrides,
  });
}

export interface ChatServerOptions {
  /** The open tabs. */
  readonly chats?: readonly ChatDto[];
  /** What Recent lists, by project; defaults to the open chats of that project. */
  readonly recent?: readonly ChatDto[];
  readonly models?: ChatModelsDto;
  readonly starts?: readonly SessionStartDto[];
  /** What an `@` query answers. */
  readonly files?: readonly ProjectFileMatchDto[];
  /** Each conversation's stored items. */
  readonly items?: Readonly<Record<string, readonly ConversationItemDto[]>>;
  /** `POST /chats` answers 409 with these words instead of creating. */
  readonly createRefusal?: string;
  /** The status the message route answers; 202 by default. */
  readonly messageStatus?: number;
}

export interface ChatServer {
  readonly handlers: HttpHandler[];
  readonly created: ChatCreateInput[];
  /** Each message the daemon took, by conversation. */
  readonly messages: { readonly conversationId: string; readonly body: unknown }[];
  readonly patches: { readonly chatId: string; readonly body: ChatPatchInput }[];
  readonly archived: string[];
  readonly unarchived: string[];
  /** The chats whose wait for Your folder was stopped. */
  readonly stoppedWaiting: string[];
  readonly fileQueries: { readonly conversationId: string; readonly q: string }[];
  /** The chats the server holds, including the ones `POST /chats` made. */
  readonly chats: ChatDto[];
}

/** The routes of Sessions, over chats held in memory. */
export function chatServer(opts: ChatServerOptions = {}): ChatServer {
  const chats = [...(opts.chats ?? [])];
  const server: ChatServer = {
    handlers: [],
    created: [],
    messages: [],
    patches: [],
    archived: [],
    unarchived: [],
    stoppedWaiting: [],
    fileQueries: [],
    chats,
  };
  const byId = (id: string): ChatDto | undefined => chats.find((c) => c.id === id);
  const byConversation = (id: string): ChatDto | undefined =>
    chats.find((c) => c.conversationId === id);
  server.handlers.push(
    http.get(daemonUrl('/chats'), () =>
      HttpResponse.json(chats.filter((c) => c.tabPosition !== null && c.archivedAt === null)),
    ),
    http.get(daemonUrl('/chats/recent'), ({ request }) => {
      const projectId = new URL(request.url).searchParams.get('projectId');
      const list = opts.recent ?? chats.filter((c) => c.lastActivityAt !== null);
      return HttpResponse.json(list.filter((c) => c.projectId === projectId));
    }),
    http.post(daemonUrl('/chats'), async ({ request }) => {
      if (opts.createRefusal !== undefined)
        return HttpResponse.json(
          { error: 'refused', message: opts.createRefusal },
          { status: 409 },
        );
      const body = (await request.json()) as ChatCreateInput;
      server.created.push(body);
      const made = chatDto({
        projectId: body.projectId,
        title: 'New session',
        titleSource: 'agent',
        tabPosition: body.tabPosition,
        lastActivityAt: null,
        conversation: { model: body.model, state: 'idle_cold' },
      });
      chats.push(made);
      return HttpResponse.json(made, { status: 201 });
    }),
    http.patch(daemonUrl('/chats/:chatId'), async ({ params, request }) => {
      const chat = byId(String(params['chatId']));
      if (chat === undefined) return HttpResponse.json({ error: 'gone' }, { status: 404 });
      const body = ChatPatchInput.parse(await request.json());
      server.patches.push({ chatId: chat.id, body });
      const changed = chatDto({
        ...chat,
        ...(body.title === undefined ? {} : { title: body.title, titleSource: 'builder' as const }),
        ...(body.tabPosition === undefined ? {} : { tabPosition: body.tabPosition }),
        conversation: {
          ...chat.conversation,
          ...(body.model === undefined ? {} : { model: body.model }),
          ...(body.effort === undefined ? {} : { effort: body.effort }),
        },
      });
      chats.splice(chats.indexOf(chat), 1, changed);
      return HttpResponse.json(changed);
    }),
    http.post(daemonUrl('/chats/:chatId/archive'), ({ params }) => {
      const chat = byId(String(params['chatId']));
      if (chat === undefined) return HttpResponse.json({ error: 'gone' }, { status: 404 });
      server.archived.push(chat.id);
      const changed = chatDto({ ...chat, tabPosition: null, archivedAt: AT });
      chats.splice(chats.indexOf(chat), 1, changed);
      return HttpResponse.json(changed);
    }),
    http.post(daemonUrl('/chats/:chatId/unarchive'), ({ params }) => {
      const chat = byId(String(params['chatId']));
      if (chat === undefined) return HttpResponse.json({ error: 'gone' }, { status: 404 });
      server.unarchived.push(chat.id);
      const changed = chatDto({ ...chat, tabPosition: chats.length, archivedAt: null });
      chats.splice(chats.indexOf(chat), 1, changed);
      return HttpResponse.json(changed);
    }),
    http.get(daemonUrl('/projects/:projectId/folder'), ({ params }) =>
      HttpResponse.json(folderDto({ projectId: ProjectId.parse(params['projectId']) })),
    ),
    http.post(daemonUrl('/chats/:chatId/stop-waiting'), ({ params }) => {
      const chat = byId(String(params['chatId']));
      if (chat === undefined) return HttpResponse.json({ error: 'gone' }, { status: 404 });
      server.stoppedWaiting.push(chat.id);
      return HttpResponse.json(chat);
    }),
    http.get(daemonUrl('/projects/:projectId/chat-models'), () =>
      HttpResponse.json(opts.models ?? chatModelsDto()),
    ),
    http.get(daemonUrl('/projects/:projectId/session-starts'), () =>
      HttpResponse.json(opts.starts ?? []),
    ),
    http.get(daemonUrl('/conversations/:conversationId/files'), ({ params, request }) => {
      server.fileQueries.push({
        conversationId: String(params['conversationId']),
        q: new URL(request.url).searchParams.get('q') ?? '',
      });
      return HttpResponse.json(opts.files ?? []);
    }),
    http.get(daemonUrl('/conversations/:conversationId'), ({ params }) => {
      const chat = byConversation(String(params['conversationId']));
      return chat === undefined
        ? HttpResponse.json({ error: 'gone' }, { status: 404 })
        : HttpResponse.json(chat.conversation);
    }),
    http.get(daemonUrl('/conversations/:conversationId/items'), ({ params }) =>
      HttpResponse.json({
        items: opts.items?.[String(params['conversationId'])] ?? [],
        nextAfterSeq: null,
      }),
    ),
    http.get(daemonUrl('/conversations/:conversationId/live'), ({ params }) =>
      HttpResponse.json({
        conversationId: params['conversationId'],
        items: [],
        waitingForFolder: false,
      }),
    ),
    http.post(daemonUrl('/conversations/:conversationId/messages'), async ({ params, request }) => {
      const conversationId = String(params['conversationId']);
      if (opts.messageStatus !== undefined && opts.messageStatus >= 400)
        return HttpResponse.json(
          { error: 'failed', message: 'The daemon could not take it.' },
          { status: opts.messageStatus },
        );
      const body: unknown = await request.json();
      server.messages.push({ conversationId, body });
      const text =
        typeof body === 'object' && body !== null && 'text' in body ? String(body.text) : '';
      return HttpResponse.json(
        ConversationItemDto.parse(builderItem(conversationId as ConversationId, text)),
        { status: 202 },
      );
    }),
  );
  return server;
}
