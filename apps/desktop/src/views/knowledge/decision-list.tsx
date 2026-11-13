import {
  KNOWLEDGE_PAGE_SIZE,
  KnowledgeItemKind,
  KnowledgeSort,
  type DecisionItem,
} from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import {
  useKnowledgeDecisions,
  type KnowledgeFilter,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import {
  firstColumnFiltering,
  ScopeFilter,
  ShelfSearchFilter,
  type ListControls,
} from './knowledge-filters';
import { dateText, scopeText, shortDateText } from './knowledge-labels';
import { usePaging } from '../../shell/table-pager';
import { orderOf, type SortColumns } from './knowledge-paging';
import { KnowledgeShelf } from './knowledge-shelf';
import { ACTIONS_COLUMN, ActionsCell, KnowledgeTable, OpenRecordText } from './knowledge-table';
import { emptyText, ListStates, StateBadge } from './record-cells';

/** The daemon's own order: newest first. */
const NEWEST: DataTableSortStatus<DecisionItem> = {
  columnAccessor: 'createdAt',
  direction: 'desc',
};

const SORTS: SortColumns = {
  scope: KnowledgeSort.Scope,
  createdAt: KnowledgeSort.CreatedAt,
  state: KnowledgeSort.State,
};

/**
 * Recorded decisions of the project in scope, current or past, a page at a time: newest first, or best
 * match first with a search. The daemon narrows, sorts and pages them.
 */
export function DecisionList({
  filter,
  controls,
  onTrace,
  actions,
}: {
  readonly filter: KnowledgeFilter;
  readonly controls: ListControls;
  readonly onTrace: (record: TracedRecord) => void;
  /** The row's menu. */
  readonly actions: (decision: DecisionItem) => ReactNode;
}) {
  const [sort, setSort] = useState<DataTableSortStatus<DecisionItem> | null>(null);
  const past = controls.shelf === KnowledgeShelf.Past;
  const order = orderOf(sort, SORTS);
  const paging = usePaging(JSON.stringify([filter, order]), KNOWLEDGE_PAGE_SIZE);
  const decisions = useKnowledgeDecisions(filter, {
    page: paging.page,
    pageSize: paging.pageSize,
    sort: order,
    kinds: [],
  });
  const answer = decisions.data;
  const rows = (answer?.items ?? []).filter(
    (i): i is DecisionItem => i.kind === KnowledgeItemKind.Decision,
  );
  const open = (d: DecisionItem): void => {
    onTrace({ kind: d.kind, id: d.id, label: d.question });
  };
  const columns: DataTableColumn<DecisionItem>[] = [
    {
      accessor: 'question',
      title: 'Decision',
      resizable: true,
      filtering: firstColumnFiltering(controls),
      filter: <ShelfSearchFilter controls={controls} />,
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
      width: 140,
      sortable: true,
      resizable: true,
      toggleable: true,
      filtering: controls.filters.scope !== null,
      filter: <ScopeFilter controls={controls} />,
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
      accessor: ACTIONS_COLUMN,
      title: '',
      width: 56,
      render: (d) => <ActionsCell>{actions(d)}</ActionsCell>,
    },
  ];
  return (
    <ListStates query={decisions} what="decisions">
      <KnowledgeTable
        label="Decisions"
        storeKey="knowledge-decisions"
        records={rows}
        columns={columns}
        idOf={(d) => d.id}
        onOpen={open}
        sort={sort ?? NEWEST}
        onSort={setSort}
        paging={{ ...paging, total: answer?.total ?? 0, page: answer?.page ?? paging.page }}
        empty={emptyText(
          decisions.data,
          'decisions',
          past
            ? 'Nothing here yet. A decision moves here once it is replaced or withdrawn.'
            : 'No decisions yet. Answers in the Inbox and the choices agents make on their own are recorded here.',
          false,
        )}
      />
    </ListStates>
  );
}
