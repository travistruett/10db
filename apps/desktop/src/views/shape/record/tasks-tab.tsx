import type { PlanTaskRow, ProjectId, ShapeId } from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useBatches, useProjects, useTasks, useWorkstreams } from '../../../daemon/queries';
import { taskRows } from '../../factory/task-rows';
import { KnowledgeTable } from '../../knowledge/knowledge-table';
import { SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';
import { RecordTab, type RecordSearch } from './record-tabs';

// Tasks: each task Convert made from the Plan, the section it was made from (which opens it), and its
// state now, said as Factory and the Board say it.

const NO_SORT = { columnAccessor: 'title', direction: 'asc' } as const;

/** "p1#task-12 · revision 1". */
export const refLabel = (ref: NonNullable<PlanTaskRow['planRef']>): string =>
  `${ref.document}#${ref.section} · revision ${String(ref.revision)}`;

export function TasksTab({
  shapeId,
  projectId,
  onSearch,
}: {
  readonly shapeId: ShapeId;
  readonly projectId: ProjectId;
  readonly onSearch: (next: RecordSearch) => void;
}) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const { query, page, paging } = useRecordPage(shapeId, 'tasks', narrowing);
  const tasks = useTasks(projectId);
  const workstreams = useWorkstreams({ active: false });
  const batches = useBatches(projectId);
  const project = useProjects().data?.find((p) => p.id === projectId);
  const ids = new Set((page?.rows ?? []).map((r) => r.taskId));
  const states = new Map(
    taskRows({
      tasks: (tasks.data ?? []).filter((t) => ids.has(t.id)),
      workstreams: (workstreams.data ?? []).filter((w) => ids.has(w.taskId)),
      batches: batches.data ?? [],
      nextTaskId: null,
      gateCommand: project?.gateCommand ?? null,
    }).map((row) => [row.taskId, row]),
  );
  const columns: DataTableColumn<PlanTaskRow>[] = [
    {
      accessor: 'title',
      title: 'Task',
      resizable: true,
      filtering: narrowing.q.trim() !== '',
      filter: (
        <SearchFilter
          value={narrowing.q}
          onChange={(q) => {
            setNarrowing({ ...narrowing, q });
          }}
        />
      ),
      render: (t) => <Text size="sm">{t.title}</Text>,
    },
    {
      accessor: 'planRef',
      title: 'Section',
      width: 260,
      toggleable: true,
      render: (t) =>
        t.planRef === null ? (
          <Text size="xs" c="dimmed">
            None
          </Text>
        ) : (
          <Anchor
            component="button"
            size="xs"
            ff="monospace"
            onClick={() => {
              if (t.planRef === null) return;
              onSearch({
                tab: RecordTab.Documents,
                doc: t.planRef.document,
                rev: t.planRef.revision,
                section: t.planRef.section,
              });
            }}
          >
            {refLabel(t.planRef)}
          </Anchor>
        ),
    },
    {
      accessor: 'state',
      title: 'State',
      width: 240,
      toggleable: true,
      render: (t) => {
        const row = states.get(t.taskId);
        if (row === undefined)
          return (
            <Text size="sm" c="dimmed">
              {tasks.isPending ? '' : 'Removed'}
            </Text>
          );
        return (
          <Group gap={6} wrap="nowrap">
            <Text size="sm" c={row.color === 'gray' ? 'dimmed' : row.color}>
              {row.state}
            </Text>
          </Group>
        );
      },
    },
  ];
  return (
    <RecordListStates query={query} what="tasks">
      <KnowledgeTable
        label="Tasks"
        storeKey="plan-record-tasks"
        records={page?.rows ?? []}
        columns={columns}
        idOf={(t) => t.taskId}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(
          narrowing.q.trim() !== '',
          'tasks',
          'Nothing was converted from this Plan yet.',
        )}
      />
    </RecordListStates>
  );
}
