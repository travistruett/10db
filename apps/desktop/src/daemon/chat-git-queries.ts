import type { ChatCommitRequest, ChatId } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { chatRoutes } from './chat-routes';
import { chatWorkKeys } from './chat-work-queries';
import { useDaemon } from './provider';

// The title row's git steps (sessions spec §4.6): each is a daemon route that needs no turn and no warm
// session. A step that has to wait for the session's own turn answers when the turn is over, so the
// request stays open until then.

/** The steps answer with what they did; the next read of the work says where that leaves the session. */
const StepResult = z.unknown();

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: chatWorkKeys.all });
    void queryClient.invalidateQueries({ queryKey: chatKeys.all });
  };
}

/** Commits the chosen files with a message. */
export function useCommitChat() {
  const { client } = useDaemon();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ chatId, ...body }: ChatCommitRequest & { readonly chatId: ChatId }) =>
      readJson(
        await client.chats[':chatId'].commit.$post({ param: { chatId }, json: body }),
        StepResult,
      ),
    onSettled: refresh,
  });
}

/** Pushes the branch and opens its pull request; from the base branch it moves the commits to a new one first. */
export function useOpenPullRequestChat() {
  const { connection } = useDaemon();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(await chatRoutes.pullRequest(connection, chatId), StepResult),
    onSettled: refresh,
  });
}

/** Merges the pull request, or, on a local project, the branch into the base. */
export function useMergeChat() {
  const { connection } = useDaemon();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(await chatRoutes.merge(connection, chatId), StepResult),
    onSettled: refresh,
  });
}
