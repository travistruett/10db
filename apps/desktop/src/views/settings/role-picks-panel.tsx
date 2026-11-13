import type { RolePickDto, StepRole } from '@10db/contracts';
import { Box, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { formatCost, NO_DATA } from './model-format';
import { ROLES } from './role-labels';

/** The colour that marks a role's pick: its dot here and its ring on the chart. */
export const PICK_COLOR = 'violet';

interface RoleLine {
  readonly role: StepRole;
  readonly label: string;
  readonly pick: RolePickDto;
}

/**
 * Who each role gets: the router's pick for every role in a table. A row selects its role on the chart, and a
 * second click clears it; the other rows dim while one is selected.
 */
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
  const lines: RoleLine[] = ROLES.flatMap(({ role, label }) => {
    const pick = picks.find((p) => p.role === role);
    return pick === undefined ? [] : [{ role, label, pick }];
  });
  const columns: DataTableColumn<RoleLine>[] = [
    {
      accessor: 'role',
      title: 'Role',
      noWrap: true,
      render: ({ role, label }) => (
        // The row's own click selects the role; the button is the keyboard's way to it and carries its state.
        <UnstyledButton aria-pressed={selected === role}>
          <Group gap="xs" wrap="nowrap">
            <Box
              w={8}
              h={8}
              style={{
                borderRadius: '50%',
                background: `var(--mantine-color-${PICK_COLOR}-6)`,
                flex: 'none',
              }}
            />
            <Text size="sm" fw={500}>
              {label}
            </Text>
          </Group>
        </UnstyledButton>
      ),
    },
    {
      accessor: 'need',
      title: 'Needs',
      textAlign: 'right',
      noWrap: true,
      cellsStyle: () => ({ fontVariantNumeric: 'tabular-nums' }),
      render: ({ pick }) => pick.need,
    },
    {
      accessor: 'model',
      title: 'Model and effort',
      noWrap: true,
      render: ({ pick }) =>
        pick.model === null
          ? 'Nothing chosen'
          : `${names.get(pick.model) ?? pick.model}${pick.effort === null ? '' : ` · ${pick.effort}`}`,
    },
    {
      accessor: 'cost',
      title: 'Cost per task',
      textAlign: 'right',
      noWrap: true,
      cellsStyle: () => ({ fontVariantNumeric: 'tabular-nums' }),
      render: ({ pick }) => (pick.model === null ? NO_DATA : formatCost(pick.costPerTaskUsd)),
    },
    {
      accessor: 'why',
      title: 'Why',
      width: '100%',
      // A zero max width lets the reason truncate to one line instead of wrapping the row.
      cellsStyle: () => ({ maxWidth: 0 }),
      render: ({ role, pick }) => (
        <Group gap="xs" wrap="nowrap">
          {pick.model !== null && notOnChart.includes(role) ? (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              Not on the chart
            </Text>
          ) : null}
          <Text size="xs" c="dimmed" truncate title={pick.reason}>
            {pick.reason}
          </Text>
        </Group>
      ),
    },
  ];
  return (
    <Stack gap="xs" component="section" aria-label="Who each role gets">
      <Title order={4} size="md" fw={600}>
        Who each role gets
      </Title>
      <DataTable<RoleLine>
        aria-label="Who each role gets, by role"
        records={lines}
        columns={columns}
        idAccessor="role"
        withTableBorder
        backgroundColor="var(--tendb-color-panel)"
        borderRadius="md"
        verticalSpacing="xs"
        horizontalSpacing="md"
        highlightOnHover
        rowStyle={({ role }) => ({
          cursor: 'pointer',
          opacity: selected !== null && selected !== role ? 0.5 : 1,
        })}
        onRowClick={({ record }) => {
          onSelect(selected === record.role ? null : record.role);
        }}
      />
      <Text size="xs" c="dimmed">
        Automatic choice for a task with no risk tags, on a project with no settings of its own.
        Plan conversations pick by the role&apos;s default effort.
      </Text>
    </Stack>
  );
}
