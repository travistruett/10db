import {
  EvalSuggestResult,
  EvalSuggestStatusDto,
  type EvalSuggestRequest,
  type ProjectId,
} from '@10db/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Whether the project has a model the New Eval wizard can ask, read once when the wizard opens. */
export function useEvalSuggestStatus(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['evals', projectId, 'suggest-status'] as const,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['eval-suggest'].$get({ param: { projectId } }),
        EvalSuggestStatusDto,
      ),
    staleTime: 60_000,
  });
}

/** One question to the project's model: a tighter sentence, more examples, or a way to check. */
export function useEvalSuggest(projectId: ProjectId) {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (input: EvalSuggestRequest) =>
      readJson(
        await client.projects[':projectId'].evals.suggest.$post({
          param: { projectId },
          json: input,
        }),
        EvalSuggestResult,
      ),
  });
}
