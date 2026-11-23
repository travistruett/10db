import {
  QUESTION_CATEGORY_HINTS,
  QuestionCategory,
  type ProjectDto,
  type RoutingRuleDto,
  type RoutingRuleInput,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Chip,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useGoals } from '../../daemon/goal-queries';
import { usePeople, useSetRoutingRules } from '../../daemon/people';
import { useTasks } from '../../daemon/queries';
import { useProjectIntegrations } from '../../daemon/sign-in-queries';
import { categoryWord, reachLabel } from '../inbox/route-line';
import { PersonModal } from './people/person-modal';
import { ruleInputs } from './route-rows';

const Scope = {
  Project: 'The Whole Project',
  Goal: 'A goal',
  Task: 'A task',
  Area: 'An Area',
  Topic: 'A topic',
} as const;
type Scope = (typeof Scope)[keyof typeof Scope];

/** Adds a route: the scope, the kind of question (or a topic's words) and who answers. */
export function AddRouteModal({
  project,
  opened,
  rules,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly opened: boolean;
  readonly rules: readonly RoutingRuleDto[];
  readonly onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Add Route" size="lg">
      <RouteForm project={project} rules={rules} onClose={onClose} />
    </Modal>
  );
}

function RouteForm({
  project,
  rules,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly rules: readonly RoutingRuleDto[];
  readonly onClose: () => void;
}) {
  const people = usePeople();
  const slack = useProjectIntegrations(project.id).data?.slack;
  const goals = useGoals(project.id);
  const tasks = useTasks(project.id);
  const save = useSetRoutingRules(project.id);
  const [scope, setScope] = useState<Scope>(Scope.Project);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [personId, setPersonId] = useState<string | null>(null);
  const [addingPerson, setAddingPerson] = useState(false);
  // Who was listed when Add Person opened: the one added then is chosen.
  const [known, setKnown] = useState<ReadonlySet<string> | null>(null);
  const others = (people.data ?? []).filter((p) => !p.isBuilder);
  const added = known === null ? undefined : others.find((p) => !known.has(p.id));
  if (added !== undefined && !addingPerson) {
    setKnown(null);
    setPersonId(added.id);
  }

  const isTopic = scope === Scope.Topic;
  const scoped =
    scope === Scope.Goal
      ? goalId !== null
      : scope === Scope.Task
        ? taskId !== null
        : scope === Scope.Area
          ? area !== null
          : true;
  const valid =
    personId !== null && scoped && (isTopic ? topic.trim() !== '' : categories.length > 0);

  const submit = (): void => {
    const person = people.data?.find((p) => p.id === personId);
    if (person === undefined) return;
    const base = {
      goalId:
        scope === Scope.Goal
          ? (goals.data?.goals.find((g) => g.goal.id === goalId)?.goal.id ?? null)
          : null,
      taskId: scope === Scope.Task ? (tasks.data?.find((t) => t.id === taskId)?.id ?? null) : null,
      area: scope === Scope.Area ? area : null,
      personId: person.id,
    };
    const added: RoutingRuleInput[] = isTopic
      ? [
          {
            category: null,
            topic: topic.trim(),
            goalId: null,
            taskId: null,
            area: null,
            personId: person.id,
          },
        ]
      : Object.values(QuestionCategory)
          .filter((c) => categories.includes(c))
          .map((category) => ({ category, topic: null, ...base }));
    save.mutate({ rules: [...ruleInputs(rules), ...added] }, { onSuccess: onClose });
  };

  return (
    <Stack>
      <Select
        label="Scope"
        data={Object.values(Scope)}
        value={scope}
        allowDeselect={false}
        onChange={(value) => {
          setScope(Object.values(Scope).find((s) => s === value) ?? Scope.Project);
        }}
      />
      {scope === Scope.Goal ? (
        <Select
          label="Goal"
          data={(goals.data?.goals ?? []).map((g) => ({ value: g.goal.id, label: g.goal.title }))}
          value={goalId}
          onChange={setGoalId}
        />
      ) : null}
      {scope === Scope.Task ? (
        <Select
          label="Task"
          data={(tasks.data ?? []).map((t) => ({ value: t.id, label: t.title }))}
          value={taskId}
          onChange={setTaskId}
        />
      ) : null}
      {scope === Scope.Area ? (
        <Select
          label="Area"
          data={project.areas.map((a) => a.name)}
          value={area}
          onChange={setArea}
        />
      ) : null}
      {isTopic ? (
        <TextInput
          label="What It's About, in a Few Words"
          description="A topic route is project-wide."
          value={topic}
          onChange={(event) => {
            setTopic(event.currentTarget.value);
          }}
        />
      ) : (
        <Chip.Group multiple value={categories} onChange={setCategories}>
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Questions
            </Text>
            <Group gap="xs">
              {Object.values(QuestionCategory).map((category) => (
                <Tooltip key={category} label={QUESTION_CATEGORY_HINTS[category].hint}>
                  <Chip value={category} size="xs">
                    {categoryWord(category)}
                  </Chip>
                </Tooltip>
              ))}
            </Group>
          </Stack>
        </Chip.Group>
      )}
      <Stack gap={6}>
        <Select
          label="Person"
          placeholder={others.length === 0 ? 'No one to route to yet' : 'Choose who answers'}
          data={others.map((p) => ({ value: p.id, label: reachLabel(p, slack) }))}
          nothingFoundMessage="No one yet. Add a person below."
          value={personId}
          onChange={setPersonId}
        />
        <Group>
          <Button
            size="compact-sm"
            variant="subtle"
            leftSection={<IconPlus size={14} stroke={1.5} />}
            onClick={() => {
              setKnown(new Set(others.map((p) => p.id)));
              setAddingPerson(true);
            }}
          >
            Add Person
          </Button>
        </Group>
      </Stack>
      <PersonModal
        person={null}
        people={people.data ?? []}
        opened={addingPerson}
        onClose={() => {
          setAddingPerson(false);
        }}
      />
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!valid} loading={save.isPending} onClick={submit}>
          Save Route
        </Button>
      </Group>
    </Stack>
  );
}
