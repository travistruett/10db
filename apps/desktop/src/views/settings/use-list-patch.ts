import { ProjectPatch, type ProjectDto } from '@10db/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys, usePatchProject } from '../../daemon/queries';

/** The first thing wrong with a patch, in words that name the field. */
function firstProblem(
  error: { readonly issues: readonly { path: PropertyKey[]; message: string }[] },
  body: Pick<ProjectPatch, 'areas' | 'hazards'>,
  editing: string | undefined,
) {
  const issue = error.issues[0];
  const list = issue?.path[0];
  const index = issue?.path[1];
  const row =
    typeof index !== 'number'
      ? undefined
      : list === 'areas'
        ? body.areas?.[index]?.name
        : list === 'hazards'
          ? body.hazards?.[index]?.name
          : undefined;
  const noun = list === 'areas' ? 'Area' : 'Hazard';
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
  const prefix = row !== undefined && row !== editing ? `${noun} ${row}: ` : '';
  return `${prefix}${where}: ${issue?.message ?? 'is not valid'}`;
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
  const save = (
    body: Pick<ProjectPatch, 'areas' | 'hazards'>,
    onSaved: () => void,
    /** The name of the row being edited, whose own faults need no prefix. */
    editing?: string,
  ) => {
    const parsed = ProjectPatch.safeParse(body);
    if (!parsed.success) {
      setProblem(firstProblem(parsed.error, body, editing));
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
