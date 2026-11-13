import {
  isSearch,
  KNOWLEDGE_PAGE_SIZE,
  KnowledgeItemKind,
  KnowledgeSort,
  PrincipleKind,
  SortDirection,
  type PrincipleItem,
} from '@10db/contracts';
import { MultiSelect, Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { useKnowledgePrinciples, type KnowledgeFilter } from '../../daemon/knowledge-queries';
import type { TracedRecord } from '../../daemon/knowledge-queries';
import {
  firstColumnFiltering,
  ScopeFilter,
  ShelfSearchFilter,
  type ListControls,
} from './knowledge-filters';
import { dateText, PRINCIPLE_KIND_LABELS, scopeText, shortDateText } from './knowledge-labels';
import { usePaging } from '../../shell/table-pager';
import { orderOf, type SortColumns } from './knowledge-paging';
import { KnowledgeShelf } from './knowledge-shelf';
import {
  ACTIONS_COLUMN,
  ActionsCell,
  KindBadge,
  KnowledgeTable,
  OpenRecordText,
} from './knowledge-table';
import { emptyText, ListStates, StateBadge } from './record-cells';

/** Policies first, then heuristics and beliefs, as the context pack orders them. */
const BY_KIND: DataTableSortStatus<PrincipleItem> = {
  columnAccessor: 'principleKind',
  direction: 'asc',
};

const SORTS: SortColumns = {
  principleKind: KnowledgeSort.Kind,
  scope: KnowledgeSort.Scope,
  createdAt: KnowledgeSort.CreatedAt,
  state: KnowledgeSort.State,
};

const KIND_CHOICES = Object.values(PrincipleKind).map((k) => ({
  value: k,
  label: PRINCIPLE_KIND_LABELS[k],
}));

const KINDS: readonly string[] = Object.values(PrincipleKind);
const isKind = (v: string): v is PrincipleKind => KINDS.includes(v);

/**
 * The principles of the project in scope, current or past, a page at a time. Policies lead unless a
 * search is typed, when the best match does; any column can re-sort them. The daemon narrows, sorts and
 * pages them.
 */
export function PrincipleList({
  filter,
  controls,
  onTrace,
  actions,
}: {
  readonly filter: KnowledgeFilter;
  readonly controls: ListControls;
  readonly onTrace: (record: TracedRecord) => void;
  /** The row's menu. */
  readonly actions: (principle: PrincipleItem) => ReactNode;
}) {
  const [sort, setSort] = useState<DataTableSortStatus<PrincipleItem> | null>(null);
  const [kinds, setKinds] = useState<readonly PrincipleKind[]>([]);
  const past = controls.shelf === KnowledgeShelf.Past;
  const order =
    sort === null && !isSearch(filter.q)
      ? { by: KnowledgeSort.Kind, dir: SortDirection.Asc }
      : orderOf(sort, SORTS);
  const paging = usePaging(JSON.stringify([filter, order, kinds]), KNOWLEDGE_PAGE_SIZE);
  const principles = useKnowledgePrinciples(filter, {
    page: paging.page,
    pageSize: paging.pageSize,
    sort: order,
    kinds,
  });
  const answer = principles.data;
  const rows = (answer?.items ?? []).filter(
    (i): i is PrincipleItem => i.kind === KnowledgeItemKind.Principle,
  );
  const open = (p: PrincipleItem): void => {
    onTrace({ kind: p.kind, id: p.id, label: p.statement });
  };
  const columns: DataTableColumn<PrincipleItem>[] = [
    {
      accessor: 'statement',
      title: 'Principle',
      resizable: true,
      filtering: firstColumnFiltering(controls),
      filter: <ShelfSearchFilter controls={controls} />,
      render: (p) => (
        <Stack gap={4}>
          <OpenRecordText
            label={p.statement}
            onOpen={() => {
              open(p);
            }}
          >
            {p.statement}
          </OpenRecordText>
          {p.rationale ? (
            <Text size="xs" c="dimmed" lineClamp={2}>
              {p.rationale}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      accessor: 'principleKind',
      title: 'Type',
      width: 120,
      sortable: true,
      resizable: true,
      toggleable: true,
      filtering: kinds.length > 0,
      filter: (
        <MultiSelect
          aria-label="Types shown"
          data={KIND_CHOICES}
          value={[...kinds]}
          onChange={(next) => {
            setKinds(next.filter(isKind));
          }}
          clearable
          comboboxProps={{ withinPortal: false }}
          w={220}
        />
      ),
      render: (p) => <KindBadge kind={p.principleKind} />,
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
      render: (p) => scopeText(p),
    },
    {
      accessor: 'createdAt',
      title: 'Date',
      width: 110,
      noWrap: true,
      sortable: true,
      resizable: true,
      toggleable: true,
      render: (p) => <span title={dateText(p.createdAt)}>{shortDateText(p.createdAt)}</span>,
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
            render: (p: PrincipleItem) => <StateBadge state={p.state} />,
          },
        ]
      : []),
    {
      accessor: ACTIONS_COLUMN,
      title: '',
      width: 56,
      render: (p) => <ActionsCell>{actions(p)}</ActionsCell>,
    },
  ];
  return (
    <ListStates query={principles} what="principles">
      <KnowledgeTable
        label="Principles"
        storeKey="knowledge-principles"
        records={rows}
        columns={columns}
        idOf={(p) => p.id}
        onOpen={open}
        sort={sort ?? BY_KIND}
        onSort={setSort}
        paging={{ ...paging, total: answer?.total ?? 0, page: answer?.page ?? paging.page }}
        empty={emptyText(
          principles.data,
          'principles',
          past
            ? 'Nothing here yet. A principle moves here once it is replaced, retired or withdrawn.'
            : 'No principles yet. Agents propose them and you confirm them under Pending or in the Inbox.',
          kinds.length > 0,
        )}
      />
    </ListStates>
  );
}
