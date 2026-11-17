import {
  INBOX_PAGE_SIZE,
  InboxKind,
  InboxListState,
  InboxOutcome,
  InboxSort,
  inboxOutcome,
  SortDirection,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import { Alert, Badge, Select, Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
import { useInboxPage } from '../../daemon/queries';
import { ProjectLabel } from '../../shell/project-label';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { usePaging } from '../../shell/table-pager';
import { InboxTable } from './inbox-table';
import { KIND_LABELS } from './permission-labels';
import { ResolvedDetail } from './resolved-detail';

/** The words for how a resolved card closed, in the column and its filter. */
const OUTCOME_LABELS: Readonly<Record<InboxOutcome, string>> = {
  [InboxOutcome.Answered]: 'Answered',
  [InboxOutcome.TenDb]: 'Closed by 10db',
  [InboxOutcome.Slack]: 'Slack Answer',
};

/** The filters' "any" choice: no filter. */
const ANY = 'any';

const KIND_CHOICES = [
  { value: ANY, label: 'Any Kind' },
  ...Object.values(InboxKind).map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];
const OUTCOME_CHOICES = [
  { value: ANY, label: 'Any Outcome' },
  ...Object.values(InboxOutcome).map((outcome) => ({
    value: outcome,
    label: OUTCOME_LABELS[outcome],
  })),
];

function isKind(value: string | null): value is InboxKind {
  return Object.values<string | null>(InboxKind).includes(value);
}
function isOutcome(value: string | null): value is InboxOutcome {
  return Object.values<string | null>(InboxOutcome).includes(value);
}

/** The columns that sort, by the daemon's name for each. */
const SORTS: Readonly<Record<string, InboxSort>> = {
  kind: InboxSort.Kind,
  title: InboxSort.Title,
  updatedAt: InboxSort.UpdatedAt,
};

const NEWEST_FIRST: DataTableSortStatus<InboxItemDto> = {
  columnAccessor: 'updatedAt',
  direction: SortDirection.Desc,
};

/** A filter's select inside its column's popover. */
function FilterSelect({
  label,
  data,
  value,
  onChange,
}: {
  readonly label: string;
  readonly data: { value: string; label: string }[];
  readonly value: string;
  readonly onChange: (value: string | null) => void;
}) {
  return (
    <Select
      aria-label={label}
      size="xs"
      w={200}
      allowDeselect={false}
      checkIconPosition="right"
      // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
      comboboxProps={{ withinPortal: false }}
      data={data}
      value={value}
      onChange={onChange}
    />
  );
}

/**
 * The inbox's resolved view: cards that were answered, dismissed, or closed by 10db, newest first, as a
 * table the daemon filters, sorts and pages. A row opens for how the card closed.
 */
export function ResolvedInbox({ project }: { readonly project: ProjectId | undefined }) {
  const now = useNow();
  const [kind, setKind] = useState<InboxKind | null>(null);
  const [outcome, setOutcome] = useState<InboxOutcome | null>(null);
  const [sort, setSort] = useState(NEWEST_FIRST);
  const [expanded, setExpanded] = useState<string[]>([]);
  const order = SORTS[String(sort.columnAccessor)] ?? InboxSort.UpdatedAt;
  const paging = usePaging(
    JSON.stringify([project, kind, outcome, order, sort.direction]),
    INBOX_PAGE_SIZE,
  );
  const resolved = useInboxPage({
    state: InboxListState.Resolved,
    ...(project === undefined ? {} : { project }),
    ...(kind === null ? {} : { kind }),
    ...(outcome === null ? {} : { outcome }),
    sort: order,
    dir: sort.direction,
    page: paging.page,
    pageSize: paging.pageSize,
  });
  const answer = resolved.data;
  const columns: DataTableColumn<InboxItemDto>[] = [
    {
      accessor: 'kind',
      title: 'Kind',
      width: 130,
      sortable: true,
      filtering: kind !== null,
      filter: (
        <FilterSelect
          label="Kind"
          data={KIND_CHOICES}
          value={kind ?? ANY}
          onChange={(next) => {
            setKind(isKind(next) ? next : null);
          }}
        />
      ),
      render: (item) => (
        <Badge size="sm" variant="light" color="gray">
          {KIND_LABELS[item.kind]}
        </Badge>
      ),
    },
    {
      accessor: 'projectId',
      title: 'Project',
      width: 150,
      render: (item) => <ProjectLabel projectId={item.projectId} />,
    },
    {
      accessor: 'title',
      title: 'Title',
      sortable: true,
      render: (item) => (
        <Text size="sm" lineClamp={2} title={item.title}>
          {item.title}
        </Text>
      ),
    },
    {
      accessor: 'outcome',
      title: 'Outcome',
      width: 160,
      filtering: outcome !== null,
      filter: (
        <FilterSelect
          label="Outcome"
          data={OUTCOME_CHOICES}
          value={outcome ?? ANY}
          onChange={(next) => {
            setOutcome(isOutcome(next) ? next : null);
          }}
        />
      ),
      render: (item) => (
        <Text size="sm" c="dimmed">
          {OUTCOME_LABELS[inboxOutcome(item)]}
        </Text>
      ),
    },
    {
      accessor: 'updatedAt',
      title: 'When',
      width: 130,
      noWrap: true,
      sortable: true,
      render: (item) => (
        <Text size="sm" c="dimmed" title={absoluteTime(item.updatedAt)}>
          {fromNow(item.updatedAt, now)}
        </Text>
      ),
    },
  ];
  return (
    <Stack gap="xs">
      {resolved.isError ? (
        <Alert color="red" title="Couldn't load the resolved cards">
          {resolved.error.message}
        </Alert>
      ) : null}
      <InboxTable<InboxItemDto>
        label="Resolved cards"
        records={answer?.items ?? []}
        columns={columns}
        sort={sort}
        onSort={setSort}
        paging={
          answer === undefined ? undefined : { ...paging, page: answer.page, total: answer.total }
        }
        fetching={resolved.isFetching && answer === undefined}
        empty={
          kind === null && outcome === null
            ? 'Nothing has been resolved yet.'
            : 'No resolved card matches these filters.'
        }
        expanded={expanded}
        onExpanded={setExpanded}
        detail={(item) => <ResolvedDetail item={item} />}
      />
    </Stack>
  );
}
