import { WorkstreamChangesDto, type ChatId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { chatWorkKeys } from './chat-work-queries';
import { useDaemon } from './provider';

/** What a session changed, as the drawer and Commit read it; under the work's key, so its events refetch it. */
export const chatChangesKey = (chatId: ChatId) => [...chatWorkKeys.of(chatId), 'changes'] as const;

/**
 * The session's changes: from the commit it started at (or `HEAD` and the uncommitted files, working here)
 * to the root now. The last diff stays on screen while a newer one is read.
 */
export function useChatChanges(chatId: ChatId | null, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: chatId === null ? ['chat-work', 'none', 'changes'] : chatChangesKey(chatId),
    queryFn: async () =>
      chatId === null
        ? Promise.reject(new Error('No session'))
        : readJson(
            await client.chats[':chatId'].changes.$get({ param: { chatId } }),
            WorkstreamChangesDto,
          ),
    enabled: chatId !== null && enabled,
    placeholderData: (previous) => previous,
  });
}
