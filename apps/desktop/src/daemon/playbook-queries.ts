import {
  PlaybookDto,
  PlaybookMoveEntry,
  type PlaybookInput,
  type ProjectId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { modelKeys } from './model-queries';
import { useDaemon } from './provider';

/** Every playbook query; a `playbook` event refetches them all. */
export const playbookKeys = {
  all: ['playbook'] as const,
  scope: (projectId: ProjectId | null) => ['playbook', projectId ?? 'all'] as const,
  moveReport: ['playbook', 'move-report'] as const,
};

const MoveReport = z.array(PlaybookMoveEntry);

/** The playbook one project sees, or the global one for null; each field says which scope set it. */
export function usePlaybook(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: playbookKeys.scope(projectId),
    queryFn: async () =>
      readJson(
        projectId === null
          ? await client.playbook.$get()
          : await client.projects[':projectId'].playbook.$get({ param: { projectId } }),
        PlaybookDto,
      ),
  });
}

/**
 * Changes rows and cells in one scope. A cell sent with every field null is cleared there; a row with null
 * steps goes back to the scope above.
 */
export function useSetPlaybook(projectId: ProjectId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PlaybookInput) =>
      readJson(
        projectId === null
          ? await client.playbook.$put({ json: input })
          : await client.projects[':projectId'].playbook.$put({
              param: { projectId },
              json: input,
            }),
        PlaybookDto,
      ),
    onSuccess: async (saved) => {
      queryClient.setQueryData(playbookKeys.scope(projectId), saved);
      // A global change moves every project's view, and each picks list follows the playbook.
      await queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      await queryClient.invalidateQueries({ queryKey: modelKeys.all });
    },
  });
}

/** The settings the move to the playbook could not carry over; empty once dismissed. */
export function usePlaybookMoveReport() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: playbookKeys.moveReport,
    queryFn: async () => readJson(await client.playbook['move-report'].$get(), MoveReport),
  });
}

export function useDismissPlaybookMoveReport() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(await client.playbook['move-report'].$delete(), z.unknown());
      await queryClient.invalidateQueries({ queryKey: playbookKeys.moveReport });
    },
  });
}
