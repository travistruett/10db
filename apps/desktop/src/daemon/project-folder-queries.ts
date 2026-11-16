import { ChatDto, FolderDto, type ChatId, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { conversationKeys } from './conversation-queries';
import { useDaemon } from './provider';

// Sessions spec §7.3: who holds a project's checkout, Your folder. The daemon says it changed with a
// `project` event (`FolderHoldChanged`); a lane, a pass or a chat's turn starting or ending says so too.

/**
 * How often an open folder line is read again. The branch changes in a terminal with no event, and a
 * window's focus is not always seen by the webview.
 */
export const FOLDER_REFRESH_MS = 15_000;

export const folderKeys = {
  all: ['project-folder'],
  of: (projectId: ProjectId) => ['project-folder', projectId] as const,
} as const;

/** The holders of the project's checkout and the branch it is on; absent until read. */
export function useProjectFolder(projectId: ProjectId | null): FolderDto | null {
  const { client } = useDaemon();
  const query = useQuery({
    queryKey: projectId === null ? ['project-folder', 'none'] : folderKeys.of(projectId),
    queryFn: async () =>
      projectId === null
        ? Promise.reject(new Error('No project'))
        : readJson(
            await client.projects[':projectId'].folder.$get({ param: { projectId } }),
            FolderDto,
          ),
    enabled: projectId !== null,
    refetchInterval: FOLDER_REFRESH_MS,
  });
  return query.data ?? null;
}

/** Stops a chat's wait for Your folder: what it queued runs reading only. */
export function useStopWaiting() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: ChatId) => {
      await readJson(
        await client.chats[':chatId']['stop-waiting'].$post({ param: { chatId } }),
        ChatDto,
      );
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: chatKeys.all });
      void queries.invalidateQueries({ queryKey: conversationKeys.all });
      void queries.invalidateQueries({ queryKey: folderKeys.all });
    },
  });
}
