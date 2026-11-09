import { KnowledgeItemKind, PrincipleKind, type PrincipleItem } from '@10db/contracts';
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
import {
  dateText,
  PRINCIPLE_KIND_LABELS,
  PRINCIPLE_KIND_ORDER,
  scopeText,
  shortDateText,
  STATE_LABELS,
} from './knowledge-labels';
import { isPast, KnowledgeShelf } from './knowledge-shelf';
import { sortRows, type Comparators } from './knowledge-sort';
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

const COMPARATORS: Comparators<PrincipleItem> = {
  principleKind: (a, b) =>
    PRINCIPLE_KIND_ORDER.indexOf(a.principleKind) - PRINCIPLE_KIND_ORDER.indexOf(b.principleKind),
  scope: (a, b) => scopeText(a).localeCompare(scopeText(b)),
  createdAt: (a, b) => a.createdAt.localeCompare(b.createdAt),
  state: (a, b) => STATE_LABELS[a.state].localeCompare(STATE_LABELS[b.state]),
};

const KIND_CHOICES = Object.values(PrincipleKind).map((k) => ({
  value: k,
  label: PRINCIPLE_KIND_LABELS[k],
}));

const KINDS: readonly string[] = Object.values(PrincipleKind);
const isKind = (v: string): v is PrincipleKind => KINDS.includes(v);

/**
 * The principles of the project in scope, current or past. Policies lead unless a search is typed, when
 * the best match does; any column can re-sort them.
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
  const principles = useKnowledgePrinciples(filter);
  const [sort, setSort] = useState<DataTableSortStatus<PrincipleItem> | null>(null);
  const [kinds, setKinds] = useState<readonly PrincipleKind[]>([]);
  const past = controls.shelf === KnowledgeShelf.Past;
  // Whether the rows answer a search is read from the answer, not the filter: rows standing in for a
  // pending answer keep their order.
  const searched = principles.data?.searched ?? false;
  const shown = (principles.data?.items ?? []).filter(
    (i): i is PrincipleItem =>
      i.kind === KnowledgeItemKind.Principle &&
      isPast(i.state) === past &&
      (kinds.length === 0 || kinds.includes(i.principleKind)),
  );
  const rows = sortRows(shown, sort ?? (searched ? null : BY_KIND), COMPARATORS);
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
      title: 'Kind',
      width: 120,
      sortable: true,
      resizable: true,
      toggleable: true,
      filtering: kinds.length > 0,
      filter: (
        <MultiSelect
          aria-label="Kinds shown"
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
