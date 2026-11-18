import { ChatWorkStateDto, type ChatCommitRequest, type ChatId } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { chatWorkKeys } from './chat-work-queries';
import { useDaemon } from './provider';

// The title row's git steps (sessions spec §4.6): each is a daemon route that needs no turn and no warm
// session. A step that has to wait for the session's own turn answers when the turn is over, so the
// request stays open until then.

/** A step answers with the state it left: the work read takes it at once, and every read is refetched behind it. */
function useSettle() {
  const queryClient = useQueryClient();
  return {
    took: (chatId: ChatId, state: ChatWorkStateDto): void => {
      queryClient.setQueryData(chatWorkKeys.of(chatId), state);
    },
    refresh: (): void => {
      void queryClient.invalidateQueries({ queryKey: chatWorkKeys.all });
      void queryClient.invalidateQueries({ queryKey: chatKeys.all });
    },
  };
}

/** Commits the chosen files with a message. */
export function useCommitChat() {
  const { client } = useDaemon();
  const { took, refresh } = useSettle();
  return useMutation({
    mutationFn: async ({ chatId, ...body }: ChatCommitRequest & { readonly chatId: ChatId }) =>
      readJson(
        await client.chats[':chatId'].commit.$post({ param: { chatId }, json: body }),
        ChatWorkStateDto,
      ),
    onSuccess: (state, { chatId }) => {
      took(chatId, state);
    },
    onSettled: refresh,
  });
}

/** Pushes the branch and opens its pull request; from the base branch it moves the commits to a new one first. */
export function useOpenPullRequestChat() {
  const { client } = useDaemon();
  const { took, refresh } = useSettle();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(
        await client.chats[':chatId']['pull-request'].$post({ param: { chatId } }),
        ChatWorkStateDto,
      ),
    onSuccess: (state, chatId) => {
      took(chatId, state);
    },
    onSettled: refresh,
  });
}

/** Merges the pull request, or, on a local project, the branch into the base. */
export function useMergeChat() {
  const { client } = useDaemon();
  const { took, refresh } = useSettle();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(await client.chats[':chatId'].merge.$post({ param: { chatId } }), ChatWorkStateDto),
    onSuccess: (state, chatId) => {
      took(chatId, state);
    },
    onSettled: refresh,
  });
}
