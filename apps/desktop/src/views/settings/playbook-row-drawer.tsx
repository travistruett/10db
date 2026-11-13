import type { PlaybookRowDto, ProjectId } from '@10db/contracts';
import { Button, Checkbox, Drawer, Group, Stack, Text } from '@mantine/core';
import { useSetPlaybook } from '../../daemon/playbook-queries';
import { scopeSource, toggleStep } from './playbook-edits';
import { RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';

/**
 * The steps a rigor runs: a checkbox per role, with Build fixed on. A change saves at once in this scope; Reset
 * hands the row back to the scope above.
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
