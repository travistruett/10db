import { FolderDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { folderKeys } from './project-folder-queries';
import { useDaemon } from './provider';

/** Cancels the pass waiting to open for the project's chats to end. */
export function useCancelPendingOpen() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: ProjectId) =>
      readJson(
        await client.projects[':projectId']['pending-open'].$delete({ param: { projectId } }),
        FolderDto,
      ),
    onSettled: () => queries.invalidateQueries({ queryKey: folderKeys.all }),
  });
}
