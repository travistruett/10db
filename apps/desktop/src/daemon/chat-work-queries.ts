import {
  ArchivePreviewDto,
  ChatWork,
  ChatWorkStateDto,
  type ChatId,
  type WorkPlace,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { chatRoutes } from './chat-routes';
import { useDaemon } from './provider';

// Where a session works and what its title row and bar read about it (sessions spec §3, §4.6). The state is
// computed on demand from the session's root, so it is read again after the events that change it: the
// chat's, a turn's end and a hold on the checkout (`project`).

/** How often a session with a pull request open reads the work again, while it is shown. */
export const PULL_REQUEST_REFRESH_MS = 120_000;

export const chatWorkKeys = {
  all: ['chat-work'],
  of: (chatId: ChatId) => ['chat-work', chatId] as const,
  archive: (chatId: ChatId) => ['chat-work', chatId, 'archive'] as const,
} as const;

/** The session's place, git state and next step; null until read, or without a session. */
export function useChatWork(chatId: ChatId | null) {
  const { connection } = useDaemon();
  return useQuery({
    queryKey: chatId === null ? ['chat-work', 'none'] : chatWorkKeys.of(chatId),
    queryFn: async () =>
      chatId === null
        ? Promise.reject(new Error('No session'))
        : readJson(await chatRoutes.work(connection, chatId), ChatWorkStateDto),
    enabled: chatId !== null,
    refetchInterval: (query) => {
      const pr = query.state.data?.pullRequest;
      return pr !== null && pr !== undefined && !pr.merged ? PULL_REQUEST_REFRESH_MS : false;
    },
  });
}

/** What choosing answered: the place chosen, or, when it was already settled, the settled one. */
export interface ChoseWork {
  readonly chosen: boolean;
  readonly work: ChatWork;
}

/** Answers the bar: Here or On a New Branch. A second choice is a 409 carrying the settled place. */
export function useChooseWork() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatId,
      place,
    }: {
      readonly chatId: ChatId;
      readonly place: Extract<WorkPlace, 'here' | 'branch'>;
    }): Promise<ChoseWork> => {
      const res = await client.chats[':chatId'].work.$post({
        param: { chatId },
        json: { place },
      });
      // A 409 is an answer, not a failure: it carries the place that had already won.
      if (res.status === 409) return { chosen: false, work: ChatWork.parse(await res.json()) };
      return { chosen: true, work: await readJson(res, ChatWork) };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: chatWorkKeys.all });
      void queryClient.invalidateQueries({ queryKey: chatKeys.all });
    },
  });
}

/** What Archive would delete with the session's worktree, read when the builder asks to archive. */
export function useArchivePreview(chatId: ChatId | null, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: chatId === null ? ['chat-work', 'none', 'archive'] : chatWorkKeys.archive(chatId),
    queryFn: async () =>
      chatId === null
        ? Promise.reject(new Error('No session'))
        : readJson(
            await client.chats[':chatId']['archive-preview'].$get({ param: { chatId } }),
            ArchivePreviewDto,
          ),
    enabled: chatId !== null && enabled,
    gcTime: 0,
  });
}
