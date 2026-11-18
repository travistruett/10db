import type { ArchiveRequest, ChatCreateInput } from '@10db/contracts';
import {
  ArchivePreviewDto,
  ChatDto,
  ChatModelsDto,
  ChatSearchPage,
  ProjectFileMatchDto,
  SessionStartDto,
  type ChatId,
  type ChatPatchInput,
  type ConversationId,
  type ProjectId,
} from '@10db/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, refuse, type DaemonClient } from './client';
import { conversationKeys } from './conversation-queries';
import { useDaemon } from './provider';

// Sessions spec §10: chats, what a fresh tab offers (models, Start from, Recent) and the files an `@`
// mention lists. Every read is parsed with its contract; every mutation refetches the chat lists once
// it settles, and the `chat` event does the same for a change made elsewhere.

export const chatKeys = {
  all: ['chats'],
  open: ['chats', 'open'],
  recent: (projectId: ProjectId) => ['chats', 'recent', projectId] as const,
  models: (projectId: ProjectId) => ['chat-models', projectId] as const,
  files: (conversationId: ConversationId, q: string) =>
    ['conversation-files', conversationId, q] as const,
  starts: (projectId: ProjectId) => ['session-starts', projectId] as const,
  search: (q: string) => ['chats', 'search', q] as const,
} as const;

const ChatList = z.array(ChatDto);
const FileMatches = z.array(ProjectFileMatchDto);
const SessionStarts = z.array(SessionStartDto);

/** How many sessions Recent lists. */
export const RECENT_SESSIONS = 6;

const NO_CHATS: readonly ChatDto[] = [];

/** The open tabs, in the strip's order. */
export function useOpenChats() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: chatKeys.open,
    queryFn: async () => readJson(await client.chats.$get({ query: { open: '1' } }), ChatList),
  });
}

/**
 * Sessions whose title holds `q`, open, closed or archived. The rows of the last search stay while the next
 * one is read, so the panel does not flash empty between keystrokes.
 */
export function useSearchChats(q: string) {
  const { client } = useDaemon();
  const text = q.trim();
  const query = useQuery({
    queryKey: chatKeys.search(text),
    queryFn: async ({ signal }) =>
      readJson(
        await client.chats.search.$get({ query: { q: text } }, { init: { signal } }),
        ChatSearchPage,
      ),
    enabled: text !== '',
    placeholderData: keepPreviousData,
  });
  return { ...query, rows: text === '' ? NO_CHATS : (query.data?.rows ?? NO_CHATS) };
}

/** The project's last sessions, most recent first, the ones that were never written to left out. */
export function useRecentChats(projectId: ProjectId | null) {
  const { client } = useDaemon();
  const query = useQuery({
    queryKey: projectId === null ? ['chats', 'recent', 'none'] : chatKeys.recent(projectId),
    queryFn: async () =>
      projectId === null
        ? NO_CHATS
        : readJson(
            await client.chats.recent.$get({
              query: { projectId, limit: String(RECENT_SESSIONS) },
            }),
            ChatList,
          ),
    enabled: projectId !== null,
  });
  return query.data ?? NO_CHATS;
}

/** What a chat in the project may run on, or the words saying why it runs none yet. */
export function useChatModels(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId === null ? ['chat-models', 'none'] : chatKeys.models(projectId),
    queryFn: async () =>
      projectId === null
        ? Promise.reject(new Error('No project'))
        : readJson(
            await client.projects[':projectId']['chat-models'].$get({ param: { projectId } }),
            ChatModelsDto,
          ),
    enabled: projectId !== null,
  });
}

/** The lines a fresh tab offers to start from, built by the daemon from the project's state. */
export function useSessionStarts(projectId: ProjectId | null) {
  const { client } = useDaemon();
  const query = useQuery({
    queryKey: projectId === null ? ['session-starts', 'none'] : chatKeys.starts(projectId),
    queryFn: async () =>
      projectId === null
        ? []
        : readJson(
            await client.projects[':projectId']['session-starts'].$get({ param: { projectId } }),
            SessionStarts,
          ),
    enabled: projectId !== null,
  });
  return query.data ?? [];
}

/** The tracked files `q` matches, for an `@` mention; a plain function, since `Mentions` asks for it. */
export async function fetchConversationFiles(
  client: DaemonClient,
  conversationId: ConversationId,
  q: string,
  signal: AbortSignal,
): Promise<ProjectFileMatchDto[]> {
  return readJson(
    await client.conversations[':conversationId'].files.$get(
      { param: { conversationId }, query: { q } },
      { init: { signal } },
    ),
    FileMatches,
  );
}

/** Makes a chat: the tab's place and model are the fresh tab's. Rejects with the daemon's words. */
export function useCreateChat() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChatCreateInput) =>
      readJson(await client.chats.$post({ json: input }), ChatDto),
    // The new tab is in the strip at once; the refetch after it settles confirms it.
    onSuccess: (chat) => {
      queryClient.setQueryData<readonly ChatDto[]>(chatKeys.open, (held) => [
        ...(held ?? []),
        chat,
      ]);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

/** Renames a chat, moves its tab, or changes its model. */
export function usePatchChat() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ chatId, ...patch }: ChatPatchInput & { readonly chatId: ChatId }) =>
      readJson(await client.chats[':chatId'].$patch({ param: { chatId }, json: patch }), ChatDto),
    // A model or effort change emits no conversation event when no session is warm, so the open
    // conversation is refetched here for the chip to show the pick.
    onSuccess: (chat) =>
      queryClient.invalidateQueries({
        queryKey: conversationKeys.one(chat.conversationId),
        exact: true,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

/** What Archive answered: the chat archived, or the files it would lose that the builder must see first. */
export type ArchiveAnswer =
  | { readonly archived: true; readonly chat: ChatDto }
  | { readonly archived: false; readonly preview: ArchivePreviewDto };

/**
 * Archives a chat: its tab closes and it leaves the open list. A session on a branch answers 409 with the
 * files that archiving would delete when `request` does not name them all; that is an answer, not a failure.
 */
export function useArchiveChat() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatId,
      request,
    }: {
      readonly chatId: ChatId;
      readonly request?: ArchiveRequest;
    }): Promise<ArchiveAnswer> => {
      const res = await client.chats[':chatId'].archive.$post(
        { param: { chatId } },
        request === undefined
          ? undefined
          : // `init.headers` would replace the client's, token included, so only the body is set; the
            // daemon reads the archive's body as text.
            { init: { body: JSON.stringify(request) } },
      );
      if (res.status === 409) {
        // A 409 is an answer, not a failure: the files archiving would delete, for the builder to see first.
        const body: unknown = await res.json().catch(() => null);
        const preview = ArchivePreviewDto.safeParse(body);
        if (preview.success) return { archived: false, preview: preview.data };
        // Any other 409 is a refusal with the daemon's words, such as a move still in flight.
        return refuse(409, body);
      }
      return { archived: true, chat: await readJson(res, ChatDto) };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

/** Brings an archived chat back. */
export function useUnarchiveChat() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(await client.chats[':chatId'].unarchive.$post({ param: { chatId } }), ChatDto),
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}
