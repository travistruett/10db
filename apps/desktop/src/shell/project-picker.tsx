import { ProjectId } from '@10db/contracts';
import { Select } from '@mantine/core';
import { useProjects } from '../daemon/queries';

export interface ProjectPickerProps {
  readonly value: ProjectId | null;
  readonly onChange: (id: ProjectId | null) => void;
  /** Defaults to a fixed width that fits the board's header. */
  readonly width?: string | number;
}

export function ProjectPicker({ value, onChange, width = 260 }: ProjectPickerProps) {
  const projects = useProjects();
  const data = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  return (
    <Select
      label="Project"
      size="sm"
      w={width}
      data={data}
      value={value}
      allowDeselect={false}
      onChange={(next) => {
        onChange(next === null ? null : ProjectId.parse(next));
      }}
    />
  );
}
