import { ProjectId, type ProjectViewDto } from '@10db/contracts';
import { useLocalStorage } from '@mantine/hooks';
import type { UseQueryResult } from '@tanstack/react-query';
import { useProjects } from '../daemon/queries';

/** The remembered project id comes from storage, so it is validated before it is trusted. */
function deserializeProjectId(value: string | undefined): ProjectId | null {
  try {
    if (value === undefined) return null;
    const parsed = ProjectId.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface SelectedProject {
  readonly projects: UseQueryResult<ProjectViewDto[]>;
  readonly project: ProjectViewDto | null;
  readonly select: (id: ProjectId | null) => void;
}

/** The project the board and Settings show; a remembered project that no longer exists falls back to the first. */
export function useSelectedProject(): SelectedProject {
  const projects = useProjects();
  const [storedId, setStoredId] = useLocalStorage<ProjectId | null>({
    key: 'tendb.project',
    defaultValue: null,
    getInitialValueInEffect: false,
    deserialize: deserializeProjectId,
  });
  const list = projects.data ?? [];
  const project = list.find((p) => p.id === storedId) ?? list[0] ?? null;
  return { projects, project, select: setStoredId };
}
