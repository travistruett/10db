import { Ships, type PlaybookRowDto, type ProjectId } from '@10db/contracts';
import { Button, Checkbox, Drawer, Group, Select, Stack, Text } from '@mantine/core';
import { useSetPlaybook } from '../../daemon/playbook-queries';
import { scopeSource, toggleStep } from './playbook-edits';
import { RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';

const SHIPS_OPTIONS = [
  { value: Ships.WithGoal, label: 'With its goal' },
  { value: Ships.Alone, label: 'Alone' },
];

const isShips = (value: string): value is Ships => SHIPS_OPTIONS.some((o) => o.value === value);

/**
 * The steps a rigor runs: a checkbox per role, with Build fixed on, and how its tasks ship: with the rest of
 * their goal in one pull request, or alone. A change saves at once in this scope; Reset hands the steps back
 * to the scope above.
 */
export function PlaybookRowDrawer({
  row,
  projectId,
  opened,
  onClose,
}: {
  readonly row: PlaybookRowDto | null;
  readonly projectId: ProjectId | null;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const set = useSetPlaybook(projectId);
  const mine = row?.steps.source === scopeSource(projectId);
  const steps = row?.steps.value ?? [];
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={row === null ? '' : `${RIGOR_LABELS[row.rigor].label}: steps`}
    >
      {row === null ? null : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {RIGOR_LABELS[row.rigor].about} Pick the steps a task of this rigor runs. Build always
            runs, and a plan review needs a plan.
          </Text>
          <Stack gap="xs">
            {ROLES.map(({ role, label, about }) => (
              <Checkbox
                key={role}
                label={label}
                description={about}
                checked={steps.includes(role)}
                disabled={role === 'implement' || set.isPending}
                onChange={(e) => {
                  set.mutate({
                    rows: [
                      { rigor: row.rigor, steps: toggleStep(steps, role, e.currentTarget.checked) },
                    ],
                  });
                }}
              />
            ))}
          </Stack>
          <Select
            label="Ships"
            description="With its goal, tasks of one goal that start together share a pull request; kinds with their own copy always ship alone."
            allowDeselect={false}
            data={SHIPS_OPTIONS}
            value={row.ships.value}
            disabled={set.isPending}
            onChange={(value) => {
              if (value !== null && isShips(value))
                set.mutate({ rows: [{ rigor: row.rigor, ships: value }] });
            }}
          />
          <Group justify="flex-end">
            <Button
              size="xs"
              variant="default"
              disabled={row.ships.source !== scopeSource(projectId) || set.isPending}
              onClick={() => {
                set.mutate({ rows: [{ rigor: row.rigor, ships: null }] });
              }}
            >
              {projectId === null ? 'Reset Ships' : 'Use Global Ships'}
            </Button>
          </Group>
          {set.isError ? (
            <Text size="xs" c="red" role="alert">
              {`Couldn't save: ${set.error.message}`}
            </Text>
          ) : null}
          <Group justify="space-between">
            <Button
              variant="default"
              disabled={!mine || set.isPending}
              onClick={() => {
                set.mutate({ rows: [{ rigor: row.rigor, steps: null }] });
              }}
            >
              Reset
            </Button>
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      )}
    </Drawer>
  );
}
