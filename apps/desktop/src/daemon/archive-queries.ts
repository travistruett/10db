import { ProjectDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { activityKeys } from './activity-queries';
import { chatKeys } from './chat-queries';
import { readJson } from './client';
import { useDaemon } from './provider';
import { queryKeys } from './queries';

/** Under the projects key, so every refresh of the project lists refreshes this one too. */
const archivedKey = [...queryKeys.projects, 'archived'] as const;

export function useArchivedProjects() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: archivedKey,
    queryFn: async () => readJson(await client.projects.archived.$get(), z.array(ProjectDto)),
  });
}

/** Archiving or restoring moves every list that spans projects, not only the project lists. */
function invalidateAcrossProjects(queryClient: QueryClient): void {
  for (const queryKey of [
    queryKeys.projects,
    queryKeys.inbox,
    ['inbox-rows'],
    chatKeys.all,
    ['workstreams'],
    ['tasks'],
    activityKeys.all,
  ])
    void queryClient.invalidateQueries({ queryKey });
}

/** Archives a project; a refusal throws with the daemon's message, which names what is still running. */
export function useArchiveProject(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // The answer is 204 with no body.
      await readJson(
        await client.projects[':projectId'].archive.$post({ param: { projectId } }),
        z.unknown(),
      );
    },
    onSuccess: () => {
      invalidateAcrossProjects(queryClient);
    },
  });
}

export function useRestoreProject() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: ProjectId) => {
      await readJson(
        await client.projects[':projectId'].restore.$post({ param: { projectId } }),
        z.unknown(),
      );
    },
    onSuccess: () => {
      invalidateAcrossProjects(queryClient);
    },
  });
}
