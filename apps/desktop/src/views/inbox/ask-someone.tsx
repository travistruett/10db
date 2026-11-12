import {
  QuestionCategory,
  type GoalId,
  type InboxItemDto,
  type PersonDto,
  type PersonId,
  type TaskId,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Group,
  Popover,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useState } from 'react';
import { useAskSomeone } from '../../daemon/people';
import { useTasks, useWorkstreams } from '../../daemon/queries';
import { QUESTION_CATEGORY_HINTS } from '@10db/contracts';
import { categoryWord, recipientsOf } from './route-line';

/** The kinds of question a stakeholder can answer; the others stay with the builder or the lane's own rules. */
const STAKEHOLDER_CATEGORIES = [
  QuestionCategory.Product,
  QuestionCategory.Design,
  QuestionCategory.Business,
] as const;

const Scope = { Task: 'task', Goal: 'goal', Project: 'project' } as const;
type Scope = (typeof Scope)[keyof typeof Scope];

function personLabel(person: PersonDto): string {
  return `${person.name} · ${person.slack === null ? 'not in Slack' : `@${person.handle}`}`;
}

/** The task and goal a card belongs to, read from the run it came from. */
function useCardScope(item: InboxItemDto): { taskId: TaskId | null; goalId: GoalId | null } {
  const workstreams = useWorkstreams({ active: true });
  const tasks = useTasks(item.projectId);
  const run = workstreams.data?.find((w) => item.targets.some((t) => t.workstreamId === w.id));
  const task = tasks.data?.find((t) => t.id === run?.taskId);
  return { taskId: task?.id ?? null, goalId: task?.goalId ?? null };
}

/**
 * Asks someone to answer a card: picks a person, and optionally writes the standing routes for the same
 * kind of question. Nothing is sent from here; the card then shows what that person will get.
 */
export function AskSomeone({
  item,
  people,
  label,
  variant = 'default',
  suggestedPersonId,
  onAsked,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
  readonly label: string;
  readonly variant?: 'default' | 'subtle';
  /** Triage's pick below the floor: the popover opens on it, with Always unticked. */
  readonly suggestedPersonId?: PersonId;
  /** Called with the people asked once the daemon has taken the route. */
  readonly onAsked?: (people: PersonDto[]) => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      // jsdom has no layout, which would read as a detached target and hide the form.
      hideDetached={false}
      position="top-end"
      width={420}
      withArrow
    >
      <Popover.Target>
        <Button
          size="sm"
          variant={variant}
          onClick={() => {
            setOpened((o) => !o);
          }}
        >
          {label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        {/* Mounted only while open, so each opening starts from the suggestion or the current route. */}
        {opened ? (
          <AskForm
            item={item}
            people={people}
            suggestedPersonId={suggestedPersonId}
            onAsked={onAsked}
            onDone={() => {
              setOpened(false);
            }}
          />
        ) : null}
      </Popover.Dropdown>
    </Popover>
  );
}

function AskForm({
  item,
  people,
  suggestedPersonId,
  onAsked,
  onDone,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
  readonly suggestedPersonId: PersonId | undefined;
  readonly onAsked: ((people: PersonDto[]) => void) | undefined;
  readonly onDone: () => void;
}) {
  const ask = useAskSomeone();
  const { taskId, goalId } = useCardScope(item);
  const candidates = people.filter((p) => !p.isBuilder);
  const current = recipientsOf(item, people)[0];
  const [personId, setPersonId] = useState<string | null>(suggestedPersonId ?? current?.id ?? null);
  const [always, setAlways] = useState(suggestedPersonId === undefined);
  const [categories, setCategories] = useState<string[]>(
    STAKEHOLDER_CATEGORIES.some((c) => c === item.category) ? [item.category] : [],
  );
  const [scope, setScope] = useState<Scope | null>(null);
  const scopes: { value: Scope; label: string }[] = [
    ...(goalId === null ? [] : [{ value: Scope.Goal, label: 'the goal' }]),
    ...(taskId === null ? [] : [{ value: Scope.Task, label: 'this task' }]),
    { value: Scope.Project, label: 'the whole project' },
  ];
  const chosenScope = scope ?? scopes[0]?.value ?? Scope.Project;
  const person = candidates.find((p) => p.id === personId);

  const submit = (): void => {
    if (person === undefined) return;
    ask.mutate(
      {
        id: item.id,
        input: {
          personIds: [person.id],
          always: always
            ? {
                categories: STAKEHOLDER_CATEGORIES.filter((c) => categories.includes(c)),
                goalId: chosenScope === Scope.Goal ? goalId : null,
                taskId: chosenScope === Scope.Task ? taskId : null,
              }
            : null,
        },
      },
      {
        onSuccess: () => {
          onAsked?.([person]);
          onDone();
        },
      },
    );
  };

  return (
    <Stack gap="sm">
      <Select
        label="Person"
        // Inside the popover, so choosing an option is not a click outside it, which would close it.
        comboboxProps={{ withinPortal: false }}
        placeholder="Who should answer?"
        data={candidates.map((p) => ({ value: p.id, label: personLabel(p) }))}
        value={personId}
        onChange={setPersonId}
      />
      <Checkbox
        checked={always}
        onChange={(event) => {
          setAlways(event.currentTarget.checked);
        }}
        label={`Always send these kinds of question to ${person?.name ?? 'them'}`}
      />
      {always ? (
        <>
          <Chip.Group multiple value={categories} onChange={setCategories}>
            <Group gap="xs">
              {STAKEHOLDER_CATEGORIES.map((category) => (
                <Tooltip key={category} label={QUESTION_CATEGORY_HINTS[category].hint}>
                  <Chip value={category} size="xs">
                    {categoryWord(category)}
                  </Chip>
                </Tooltip>
              ))}
            </Group>
          </Chip.Group>
          <Select
            label="On"
            comboboxProps={{ withinPortal: false }}
            data={scopes}
            value={chosenScope}
            allowDeselect={false}
            onChange={(value) => {
              setScope(scopes.find((s) => s.value === value)?.value ?? null);
            }}
          />
          <Text size="xs" c="dimmed">
            Saved in Who Answers.
          </Text>
        </>
      ) : null}
      {ask.isError ? (
        <Alert color="red" variant="light">
          {ask.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={person === undefined || (always && categories.length === 0)}
          loading={ask.isPending}
          onClick={submit}
        >
          {person === undefined ? 'Ask' : `Ask ${person.name}`}
        </Button>
      </Group>
    </Stack>
  );
}
