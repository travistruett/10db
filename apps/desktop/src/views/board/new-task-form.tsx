import { TaskStatus, type ProjectDto, type TaskDto } from '@10db/contracts';
import { Alert, Button, Group, MultiSelect, Stack, Textarea, TextInput } from '@mantine/core';
import { useState, type SyntheticEvent } from 'react';
import { useCreateTask } from '../../daemon/queries';
import { criteriaLines } from './areas-text';

export interface NewTaskFormProps {
  readonly project: ProjectDto;
  readonly tasks: readonly TaskDto[];
  readonly onCreated: (task: TaskDto) => void;
}

/** A project with one area is the common case; preselect it. */
function initialAreas(project: ProjectDto): string[] {
  const [only, ...rest] = project.areas;
  return only && rest.length === 0 ? [only.name] : [];
}

export function NewTaskForm({ project, tasks, onCreated }: NewTaskFormProps) {
  const create = useCreateTask(project.id);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [areas, setAreas] = useState<string[]>(() => initialAreas(project));
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const areaNames = [...project.areas.map((a) => a.name), ...project.hazards.map((h) => h.name)];
  const dependencyOptions = tasks
    .filter((t) => t.status === TaskStatus.Open)
    .map((t) => ({ value: t.id, label: t.title }));

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const acceptanceCriteria = criteriaLines(criteriaText);
    if (acceptanceCriteria.length === 0) {
      setFormError('Add at least one acceptance criterion');
      return;
    }
    if (areas.length === 0) {
      setFormError('Choose at least one area');
      return;
    }
    setFormError(null);
    create.mutate(
      {
        title: title.trim(),
        description: description.trim(),
        acceptanceCriteria,
        areas,
        // Map back through the task list so the ids keep their branded type.
        dependsOn: tasks.filter((t) => dependsOn.includes(t.id)).map((t) => t.id),
      },
      {
        onSuccess: (task) => {
          onCreated(task);
        },
      },
    );
  };

  const error = formError ?? create.error?.message ?? null;
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
          }}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          value={description}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
          }}
        />
        <Textarea
          label="Acceptance criteria"
          description="One per line"
          autosize
          minRows={3}
          value={criteriaText}
          onChange={(e) => {
            setCriteriaText(e.currentTarget.value);
          }}
        />
        <MultiSelect label="Areas" data={areaNames} value={areas} onChange={setAreas} searchable />
        <MultiSelect
          label="Depends on"
          data={dependencyOptions}
          value={dependsOn}
          onChange={setDependsOn}
          searchable
          clearable
        />
        {error ? (
          <Alert color="red" title="Couldn't create the task">
            {error}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={create.isPending}>
            Create task
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
