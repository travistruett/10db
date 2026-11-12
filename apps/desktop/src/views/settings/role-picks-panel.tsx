import type { StepRole } from '@10db/contracts';
import type { RolePickDto } from '@10db/contracts';
import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { formatCost } from './model-format';
import { ROLES } from './role-labels';

/** Who each role gets: the router's pick for every role, a row that selects the role on the chart. */
export function RolePicksPanel({
  picks,
  names,
  notOnChart,
  selected,
  onSelect,
}: {
  readonly picks: readonly RolePickDto[];
  /** A model's name by its ID; a model not named here shows its ID. */
  readonly names: ReadonlyMap<string, string>;
  readonly notOnChart: readonly StepRole[];
  readonly selected: StepRole | null;
  readonly onSelect: (role: StepRole | null) => void;
}) {
  return (
    <Stack gap="xs" component="section" aria-label="Who each role gets">
      <Text fw={500}>Who each role gets</Text>
      {ROLES.map(({ role, label }) => {
        const pick = picks.find((p) => p.role === role);
        if (pick === undefined) return null;
        const pressed = selected === role;
        return (
          <UnstyledButton
            key={role}
            aria-pressed={pressed}
            onClick={() => {
              onSelect(pressed ? null : role);
            }}
            p="xs"
            style={{
              border: '1px solid var(--mantine-color-default-border)',
              borderRadius: 'var(--mantine-radius-sm)',
              opacity: selected !== null && !pressed ? 0.5 : 1,
              background: pressed ? 'var(--mantine-color-default-hover)' : undefined,
            }}
          >
            <Group gap="md" wrap="nowrap" align="flex-start">
              <Stack gap={0} w={90}>
                <Text size="sm" fw={500}>
                  {label}
                </Text>
                <Text size="xs" c="dimmed">
                  needs {pick.need}
                </Text>
              </Stack>
              <Stack gap={2} style={{ flex: 1 }}>
                <Group gap="xs">
                  <Text size="sm">
                    {pick.model === null ? 'Nothing chosen' : (names.get(pick.model) ?? pick.model)}
                  </Text>
                  {pick.effort === null ? null : <Text size="sm">{pick.effort}</Text>}
                  {pick.model === null ? null : (
                    <Text size="sm" c="dimmed">
                      {formatCost(pick.costPerTaskUsd)} a task
                    </Text>
                  )}
                  {notOnChart.includes(role) ? (
                    <Badge size="sm" variant="light" color="gray">
                      Not on the chart
                    </Badge>
                  ) : null}
                </Group>
                <Text size="xs" c="dimmed">
                  {pick.reason}
                </Text>
              </Stack>
            </Group>
          </UnstyledButton>
        );
      })}
      <Text size="xs" c="dimmed">
        What a task with no risk tags gets on this account with no project settings: project role
        settings, project patterns, risk floors and budget ceilings can change it. A Plan
        conversation picks by the role&apos;s default effort, not by score.
      </Text>
    </Stack>
  );
}
