import {
  KnowledgeItemKind,
  KnowledgeScope,
  matchesSearch,
  PRINCIPLE_KIND_ORDER,
  type PrincipleDto,
  type ProposalDto,
} from '@10db/contracts';
import { Alert, Loader, Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { useProposals, type TracedRecord } from '../../daemon/knowledge-queries';
import {
  firstColumnFiltering,
  ScopeFilter,
  ShelfSearchFilter,
  type FilterState,
  type ListControls,
} from './knowledge-filters';
import { dateText, scopeText, shortDateText } from './knowledge-labels';
import { sortRows, type Comparators } from './knowledge-sort';
import {
  ACTIONS_COLUMN,
  ActionsCell,
  KindBadge,
  KnowledgeTable,
  OpenRecordText,
} from './knowledge-table';

/** A principle proposal and the principle it would confirm. */
interface PendingRow {
  readonly proposal: ProposalDto;
  readonly principle: PrincipleDto;
}

/** Principle proposals: the only ones Knowledge decides. Every other proposal is answered in the Inbox. */
export function pendingPrinciples(proposals: readonly ProposalDto[]): PendingRow[] {
  return proposals.flatMap((proposal) =>
    proposal.principle ? [{ proposal, principle: proposal.principle }] : [],
  );
}

/** Search and scope narrow pending principles the way they narrow the lists. */
function matches({ proposal, principle }: PendingRow, filter: FilterState): boolean {
  if (filter.scope !== null && principle.scope !== filter.scope) return false;
  if (filter.scope === KnowledgeScope.Area && principle.area !== filter.area) return false;
  // The same rule as the daemon's search of the other shelves: every word starts some word of the text.
  return matchesSearch(
    [proposal.title, proposal.body, principle.statement, principle.topicKey].join(' '),
    filter.q,
  );
}

const NEWEST: DataTableSortStatus<PendingRow> = { columnAccessor: 'createdAt', direction: 'desc' };

const COMPARATORS: Comparators<PendingRow> = {
  kind: (a, b) =>
    PRINCIPLE_KIND_ORDER.indexOf(a.principle.kind) - PRINCIPLE_KIND_ORDER.indexOf(b.principle.kind),
  scope: (a, b) => scopeText(a.principle).localeCompare(scopeText(b.principle)),
  createdAt: (a, b) => a.proposal.createdAt.localeCompare(b.proposal.createdAt),
};

/** Principles agents and answers proposed, waiting on the builder. Their text is shown as text only. */
export function ProposalList({
  projectId,
  filter,
  controls,
  onTrace,
  actions,
}: {
  readonly projectId: ProposalDto['projectId'];
  /** Search and scope, the search already debounced. */
  readonly filter: FilterState;
  readonly controls: ListControls;
  readonly onTrace: (record: TracedRecord) => void;
  /** Accept and Reject for a proposal. */
  readonly actions: (proposal: ProposalDto) => ReactNode;
}) {
  const proposals = useProposals(projectId);
  const [sort, setSort] = useState<DataTableSortStatus<PendingRow> | null>(null);
  if (proposals.isError)
    return (
      <Alert color="red" title="Couldn't load the proposals">
        {proposals.error.message}
      </Alert>
    );
  if (proposals.isPending) return <Loader size="sm" aria-label="Loading proposals" />;
  const pending = pendingPrinciples(proposals.data);
  const rows = sortRows(
    pending.filter((row) => matches(row, filter)),
    sort,
    COMPARATORS,
  );
  const open = ({ principle }: PendingRow): void => {
    onTrace({ kind: KnowledgeItemKind.Principle, id: principle.id, label: principle.statement });
  };
  const columns: DataTableColumn<PendingRow>[] = [
    {
      accessor: 'statement',
      title: 'Proposal',
      resizable: true,
      filtering: firstColumnFiltering(controls),
      filter: <ShelfSearchFilter controls={controls} />,
      render: (row) => (
        <Stack gap={4}>
          <OpenRecordText
            label={row.principle.statement}
            onOpen={() => {
              open(row);
            }}
          >
            {row.principle.statement}
          </OpenRecordText>
          <Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: 'pre-wrap' }}>
            {row.proposal.body}
          </Text>
        </Stack>
      ),
    },
    {
      accessor: 'kind',
      title: 'Type',
      width: 120,
      sortable: true,
      resizable: true,
      toggleable: true,
      render: (row) => <KindBadge kind={row.principle.kind} />,
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
      render: (row) => scopeText(row.principle),
    },
    {
      accessor: 'createdAt',
      title: 'Date',
      width: 110,
      noWrap: true,
      sortable: true,
      resizable: true,
      toggleable: true,
      render: (row) => (
        <span title={dateText(row.proposal.createdAt)}>
          {shortDateText(row.proposal.createdAt)}
        </span>
      ),
    },
    {
      accessor: ACTIONS_COLUMN,
      title: '',
      width: 190,
      render: (row) => <ActionsCell>{actions(row.proposal)}</ActionsCell>,
    },
  ];
  return (
    <KnowledgeTable
      label="Proposals"
      storeKey="knowledge-proposals"
      records={rows}
      columns={columns}
      idOf={(row) => row.proposal.id}
      onOpen={open}
      sort={sort ?? NEWEST}
      onSort={setSort}
      empty={pending.length === 0 ? 'No proposals wait for you.' : 'No proposal matches.'}
    />
  );
}
