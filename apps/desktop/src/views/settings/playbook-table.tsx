import {
  RIGORS,
  type AccountId,
  type PlaybookRowDto,
  type ProjectId,
  type Rigor,
} from '@10db/contracts';
import { Button, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useEveryRigorPicks, useModels } from '../../daemon/model-queries';
import { usePlaybook } from '../../daemon/playbook-queries';
import { PlaybookCellButton, PlaybookCellEditor } from './playbook-cell-editor';
import { processLine, scopeSource } from './playbook-edits';
import { PlaybookRowDrawer } from './playbook-row-drawer';
import { RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';

/**
 * The playbook of one scope: a row per rigor saying which steps run and how it is reviewed, and a cell per rigor and role showing what
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
    return <PageLoading shape={PageLoadingShape.List} rows={4} label="Reading the playbook" />;

  const columns: DataTableColumn<PlaybookRowDto>[] = [
    {
      accessor: 'rigor',
      title: 'Rigor',
      width: 230,
      noWrap: true,
      render: (row) => (
        // What the rigor is for is the tooltip; the row shows its name and the process it runs.
        <Tooltip label={RIGOR_LABELS[row.rigor].about} position="right" openDelay={300}>
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
            <Text size="xs" c="dimmed" truncate maw={210}>
              {processLine(row)}
            </Text>
          </UnstyledButton>
        </Tooltip>
      ),
    },
    ...ROLES.map(({ role, label }): DataTableColumn<PlaybookRowDto> => ({
      accessor: role,
      title: label,
      noWrap: true,
      cellsStyle: () => ({ minWidth: 170 }),
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
      <RaisedPanel>
        <DataTable<PlaybookRowDto>
          aria-label="Playbook"
          records={ordered}
          columns={columns}
          idAccessor="rigor"
          backgroundColor="transparent"
          verticalSpacing="xs"
          horizontalSpacing="md"
          // Too narrow a frame scrolls the table sideways instead of wrapping a model name.
          styles={{ table: { minWidth: 1000 } }}
        />
      </RaisedPanel>
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
