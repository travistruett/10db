import { ProjectPatch, type ProjectDto } from '@10db/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys, usePatchProject } from '../../daemon/queries';

/** The first thing wrong with a patch, in words that name the field. */
function firstProblem(error: {
  readonly issues: readonly { path: PropertyKey[]; message: string }[];
}) {
  const issue = error.issues[0];
  const field = issue?.path[2];
  const where =
    field === 'globs'
      ? 'Paths'
      : field === 'name'
        ? 'Name'
        : field === 'route'
          ? 'Route'
          : field === 'label'
            ? 'Label'
            : field === 'commands'
              ? 'Commands'
              : 'Areas and Hazards';
  return `${where}: ${issue?.message ?? 'is not valid'}`;
}

/**
 * Saves a project's area or hazard list in one `PATCH`, checking it first with the daemon's own rules.
 * The words of a refusal, the project's or the daemon's, are in `problem`; a refused save reads the
 * project again, since a refusal usually means it changed underneath.
 */
export function useListPatch(project: ProjectDto) {
  const patch = usePatchProject(project.id);
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const save = (body: Pick<ProjectPatch, 'areas' | 'hazards'>, onSaved: () => void) => {
    const parsed = ProjectPatch.safeParse(body);
    if (!parsed.success) {
      setProblem(firstProblem(parsed.error));
      return;
    }
    setProblem(null);
    patch.mutate(parsed.data, {
      onSuccess: onSaved,
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      },
    });
  };
  return {
    save,
    saving: patch.isPending,
    problem: problem ?? patch.error?.message ?? null,
    clear: () => {
      setProblem(null);
      patch.reset();
    },
  };
}
