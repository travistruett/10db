import type { ProjectId, ProjectViewDto } from '@10db/contracts';
import { Select } from '@mantine/core';

const ALL = 'all';

/**
 * A global view's project filter: every project, or one. It is the view's own and shows what it is
 * set to, so the project chosen in the sidebar never narrows a global view unseen.
 */
export function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  readonly projects: readonly ProjectViewDto[];
  readonly value: ProjectId | null;
  readonly onChange: (project: ProjectId | null) => void;
}) {
  return (
    <Select
      aria-label="Project"
      size="sm"
      w={200}
      allowDeselect={false}
      data={[
        { value: ALL, label: 'All projects' },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ]}
      value={value ?? ALL}
      onChange={(next) => {
        onChange(projects.find((p) => p.id === next)?.id ?? null);
      }}
    />
  );
}
