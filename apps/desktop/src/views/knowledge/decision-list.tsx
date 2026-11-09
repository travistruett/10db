import { KnowledgeItemKind, type DecisionItem } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import {
  useKnowledgeDecisions,
  type KnowledgeFilter,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { dateText, scopeText, shortDateText, STATE_LABELS } from './knowledge-labels';
import { isPast } from './knowledge-shelf';
import { sortRows, type Comparators } from './knowledge-sort';
import { ActionsCell, KnowledgeTable, OpenRecordText } from './knowledge-table';
import { ListStates, StateBadge } from './record-cells';

/** The daemon's own order: newest first. */
const NEWEST: DataTableSortStatus<DecisionItem> = {
  columnAccessor: 'createdAt',
  direction: 'desc',
};

const COMPARATORS: Comparators<DecisionItem> = {
  scope: (a, b) => scopeText(a).localeCompare(scopeText(b)),
  createdAt: (a, b) => a.createdAt.localeCompare(b.createdAt),
  state: (a, b) => STATE_LABELS[a.state].localeCompare(STATE_LABELS[b.state]),
};

/** Recorded decisions of the project in scope, current or past: newest first, or best match first with a search. */
export function DecisionList({
  filter,
  past,
  onTrace,
  actions,
}: {
  readonly filter: KnowledgeFilter;
  /** The Past shelf: only what no longer applies, with its state said. */
  readonly past: boolean;
  readonly onTrace: (record: TracedRecord) => void;
  /** The row's menu. */
  readonly actions: (decision: DecisionItem) => ReactNode;
}) {
  const decisions = useKnowledgeDecisions(filter);
  const [sort, setSort] = useState<DataTableSortStatus<DecisionItem> | null>(null);
  const shown = (decisions.data?.items ?? []).filter(
    (i): i is DecisionItem => i.kind === KnowledgeItemKind.Decision && isPast(i.state) === past,
  );
  const rows = sortRows(shown, sort, COMPARATORS);
  const open = (d: DecisionItem): void => {
    onTrace({ kind: d.kind, id: d.id, label: d.question });
  };
  const columns: DataTableColumn<DecisionItem>[] = [
    {
      accessor: 'question',
      title: 'Decision',
      resizable: true,
      render: (d) => (
        <Stack gap={4}>
          <OpenRecordText
            label={d.question}
            onOpen={() => {
              open(d);
            }}
          >
            {d.question}
          </OpenRecordText>
          <Text size="sm" fw={500}>
            {d.choice}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {d.rationale}
          </Text>
        </Stack>
      ),
    },
    {
      accessor: 'scope',
      title: 'Scope',
      width: 120,
      sortable: true,
      resizable: true,
      toggleable: true,
      render: (d) => scopeText(d),
    },
    {
      accessor: 'createdAt',
      title: 'Date',
      width: 110,
      noWrap: true,
      sortable: true,
      resizable: true,
      toggleable: true,
      render: (d) => <span title={dateText(d.createdAt)}>{shortDateText(d.createdAt)}</span>,
    },
    ...(past
      ? [
          {
            accessor: 'state',
            title: 'State',
            width: 130,
            sortable: true,
            resizable: true,
            toggleable: true,
            render: (d: DecisionItem) => <StateBadge state={d.state} />,
          },
        ]
      : []),
    {
      accessor: 'actions',
      title: '',
      width: 56,
      render: (d) => <ActionsCell>{actions(d)}</ActionsCell>,
    },
  ];
  return (
    <ListStates
      query={decisions}
      what="decisions"
      empty={
        past
          ? 'Nothing here yet. A decision moves here once it is replaced or withdrawn.'
          : 'No decisions yet. Answers in the Inbox and the choices agents make on their own are recorded here.'
      }
      shown={rows.length}
    >
      <KnowledgeTable
        label="Decisions"
        storeKey="knowledge-decisions"
        records={rows}
        columns={columns}
        idOf={(d) => d.id}
        onOpen={open}
        sort={sort ?? NEWEST}
        onSort={setSort}
      />
    </ListStates>
  );
}
