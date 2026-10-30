import { Delivery, TaskStatus, type ProjectDto, type TaskDto } from '@10db/contracts';
import { Box, Code, List, MultiSelect, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import { useCreateTask } from '../../daemon/queries';
import { criteriaLines } from './areas-text';
import { LabelWithHelp } from './field-help';
import { draftFor, landingFromDraft, type LandingDraft } from './landing-draft';
import { LandingField } from './landing-field';

const CRITERIA_PLACEHOLDER =
  'One per line, for example:\nSearch shows results in under a second with 10,000 tasks';

export interface NewTaskFormProps {
  /** The form's `id`: a submit button outside it (the modal footer) points at it with `form`. */
  readonly formId: string;
  readonly project: ProjectDto;
  readonly tasks: readonly TaskDto[];
  /** Reports whether a create is in flight and why the last one failed, for the footer to show. */
  readonly onStatus: (status: { readonly pending: boolean; readonly error: string | null }) => void;
  readonly onCreated: (task: TaskDto) => void;
}

/** A project with one area is the common case; preselect it. */
function initialAreas(project: ProjectDto): string[] {
  const [only, ...rest] = project.areas;
  return only && rest.length === 0 ? [only.name] : [];
}

export function NewTaskForm({ formId, project, tasks, onStatus, onCreated }: NewTaskFormProps) {
  const create = useCreateTask(project.id);
  const criteriaId = useId();
  const areasId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [areas, setAreas] = useState<string[]>(() => initialAreas(project));
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [landing, setLanding] = useState<LandingDraft>(() => draftFor(project));
  const [landingError, setLandingError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Local delivery commits straight to the checked-out branch: there is no pull request to place.
  const pullRequests = project.delivery === Delivery.PullRequest;

  // Hazards stay out: an agent asks for one with `request_claim`.
  const areaNames = project.areas.map((a) => a.name);
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
    const where = landingFromDraft(landing);
    if (pullRequests && !where.ok) {
      setFormError(null);
      setLandingError(where.error);
      return;
    }
    setFormError(null);
    setLandingError(null);
    create.mutate(
      {
        title: title.trim(),
        description: description.trim(),
        acceptanceCriteria,
        areas,
        // Map back through the task list so the ids keep their branded type.
        dependsOn: tasks.filter((t) => dependsOn.includes(t.id)).map((t) => t.id),
        ...(pullRequests && where.ok ? { landing: where.landing } : {}),
      },
      {
        onSuccess: (task) => {
          onCreated(task);
        },
      },
    );
  };

  const error = formError ?? create.error?.message ?? null;
  const pending = create.isPending;
  useEffect(() => {
    onStatus({ pending, error });
  }, [onStatus, pending, error]);

  return (
    <form id={formId} onSubmit={submit} noValidate>
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
          minRows={1}
          maxRows={10}
          value={description}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
          }}
        />
        <Box>
          <LabelWithHelp label="Acceptance criteria" htmlFor={criteriaId}>
            <Stack gap="xs">
              <Text size="sm">
                What must be true when the task is done. The agent works until each one holds, a
                reviewer agent checks each and asks for a test that proves it
                {project.gateCommand === null ? (
                  ', and you check the finished work yourself.'
                ) : (
                  <>
                    , and the project's gate (<Code>{project.gateCommand}</Code>) runs separately.
                  </>
                )}
              </Text>
              <List size="sm" spacing={4}>
                <List.Item>
                  Instead of "Make search faster", write "Search shows results in under a second
                  with 10,000 tasks".
                </List.Item>
                <List.Item>
                  Instead of "Fix the login bug", write "Signing in with an expired password says
                  so, instead of showing a blank page".
                </List.Item>
              </List>
            </Stack>
          </LabelWithHelp>
          <Textarea
            id={criteriaId}
            placeholder={CRITERIA_PLACEHOLDER}
            autosize
            minRows={2}
            maxRows={12}
            value={criteriaText}
            onChange={(e) => {
              setCriteriaText(e.currentTarget.value);
            }}
          />
        </Box>
        {areaNames.length > 1 ? (
          <Box>
            <LabelWithHelp label="Areas" htmlFor={areasId}>
              <Text size="sm">
                The parts of the project this task may change. 10db keeps the agent's edits inside
                them, and runs tasks in different areas at the same time.
              </Text>
            </LabelWithHelp>
            <MultiSelect
              id={areasId}
              data={areaNames}
              value={areas}
              onChange={setAreas}
              searchable
            />
          </Box>
        ) : null}
        <MultiSelect
          label="Depends on"
          data={dependencyOptions}
          value={dependsOn}
          onChange={setDependsOn}
          searchable
          clearable
        />
        {pullRequests ? (
          <LandingField
            baseBranch={project.baseBranch}
            value={landing}
            error={landingError}
            onChange={(draft) => {
              setLanding(draft);
              setLandingError(null);
            }}
          />
        ) : null}
      </Stack>
    </form>
  );
}
