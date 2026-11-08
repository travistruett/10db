import { HazardAssessmentDto, HazardLookAgainResult, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Prefix of every project's assessment; events about a project invalidate by it. */
export const HAZARD_ASSESSMENT_KEY = ['hazard-assessment'] as const;

/** What 10db added to the project's hazards by itself, and why. */
export function useHazardAssessment(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...HAZARD_ASSESSMENT_KEY, projectId],
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['hazard-assessment'].$get({ param: { projectId } }),
        HazardAssessmentDto,
      ),
  });
}

/**
 * Reads the project's main checkout again. Additions are saved as they were the first time; a removal
 * only raises the Inbox card. A model that is unavailable changes nothing and answers why.
 */
export function useLookAgainAtHazards(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId']['hazard-assessment']['look-again'].$post({
          param: { projectId },
        }),
        HazardLookAgainResult,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: HAZARD_ASSESSMENT_KEY }),
  });
}

/** Takes one of 10db's additions back out of its hazard. */
export function useUndoHazardAddition(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (additionId: string) =>
      readJson(
        await client.projects[':projectId']['hazard-assessment'].additions[':additionId'].$delete({
          param: { projectId, additionId },
        }),
        HazardAssessmentDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: HAZARD_ASSESSMENT_KEY }),
  });
}
