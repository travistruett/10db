import {
  RIGORS,
  type AccountId,
  type PlaybookRowDto,
  type ProjectId,
  type Rigor,
} from '@10db/contracts';
import { Button, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useEveryRigorPicks, useModels } from '../../daemon/model-queries';
import { usePlaybook } from '../../daemon/playbook-queries';
import { PlaybookCellButton, PlaybookCellEditor } from './playbook-cell-editor';
import { scopeSource } from './playbook-edits';
import { PlaybookRowDrawer } from './playbook-row-drawer';
import { RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';

/**
 * The playbook of one scope: a row per rigor saying which steps run, and a cell per rigor and role showing what
 * it resolves to on the account. A row's name opens its steps, a cell opens its editor.
 */
export function PlaybookTable({
  projectId,
  accountId,
}: {
  /** The project whose playbook this is; null for the one that applies everywhere. */
  readonly projectId: ProjectId | null;
  /** The account the cells are resolved on. */
  readonly accountId: AccountId | null;
}) {
  const playbook = usePlaybook(projectId);
  const picks = useEveryRigorPicks(accountId, projectId);
  const models = useModels(accountId, accountId !== null);
  const [drawerRigor, setDrawerRigor] = useState<Rigor | null>(null);
  const names = new Map((models.data ?? []).map((m) => [m.model, m.name]));
  const source = scopeSource(projectId);

  if (playbook.isError && playbook.data === undefined)
    return (
      <Text size="sm" c="red" role="alert">
        {playbook.error.message}
      </Text>
    );
  const view = playbook.data;
  if (view === undefined)
    return (
      <Text size="sm" c="dimmed">
        Reading the playbook…
      </Text>
    );

  const columns: DataTableColumn<PlaybookRowDto>[] = [
    {
      accessor: 'rigor',
      title: 'Rigor',
      noWrap: true,
      render: (row) => (
        <UnstyledButton
          aria-label={`${RIGOR_LABELS[row.rigor].label} steps`}
          onClick={() => {
            setDrawerRigor(row.rigor);
          }}
        >
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600}>
              {RIGOR_LABELS[row.rigor].label}
            </Text>
            {row.steps.source === source ? (
              <Text size="xs" c="dimmed" title="Steps set here">
                set here
              </Text>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {RIGOR_LABELS[row.rigor].about}
          </Text>
        </UnstyledButton>
      ),
    },
    ...ROLES.map(({ role, label }): DataTableColumn<PlaybookRowDto> => ({
      accessor: role,
      title: label,
      width: 190,
      render: (row) => {
        const cell = view.cells.find((c) => c.rigor === row.rigor && c.role === role);
        if (cell === undefined || !row.steps.value.includes(role)) return null;
        const pick = picks.get(row.rigor)?.data?.picks.find((p) => p.role === role);
        const changedHere = [cell.personaId, cell.model, cell.effort].some(
          (f) => f.source === source,
        );
        return (
          <PlaybookCellEditor
            cell={cell}
            pick={pick}
            names={names}
            projectId={projectId}
            accountId={accountId}
          >
            {(open) => (
              <PlaybookCellButton
                cell={cell}
                pick={pick}
                names={names}
                changedHere={changedHere}
                onClick={open}
              />
            )}
          </PlaybookCellEditor>
        );
      },
    })),
  ];
  const ordered = RIGORS.flatMap((rigor) => view.rows.filter((r) => r.rigor === rigor));
  const drawerRow = view.rows.find((r) => r.rigor === drawerRigor) ?? null;
  const failed = [...picks.values()].find((q) => q?.isError);
  return (
    <Stack gap="xs">
      <DataTable<PlaybookRowDto>
        aria-label="Playbook"
        records={ordered}
        columns={columns}
        idAccessor="rigor"
        withTableBorder
        backgroundColor="var(--tendb-color-panel)"
        borderRadius="md"
        verticalSpacing="xs"
        horizontalSpacing="md"
      />
      {failed?.isError ? (
        <Group gap="sm">
          <Text size="xs" c="red" role="alert">
            {failed.error.message}
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              for (const query of picks.values()) if (query?.isError) void query.refetch();
            }}
          >
            Try Again
          </Button>
        </Group>
      ) : null}
      <PlaybookRowDrawer
        row={drawerRow}
        projectId={projectId}
        opened={drawerRigor !== null}
        onClose={() => {
          setDrawerRigor(null);
        }}
      />
    </Stack>
  );
}
