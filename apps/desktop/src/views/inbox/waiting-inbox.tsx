import {
  INBOX_PAGE_SIZE,
  InboxListState,
  InboxSort,
  SortDirection,
  type InboxItemDto,
  type PersonId,
  type ProjectId,
} from '@10db/contracts';
import { Alert, Select, Stack, Text } from '@mantine/core';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
import { usePeople, useSlackConnection } from '../../daemon/people';
import { useInboxPage } from '../../daemon/queries';
import { ProjectLabel } from '../../shell/project-label';
import { useNow } from '../../shell/relative';
import { usePaging } from '../../shell/table-pager';
import { shortAgo } from '../factory/short-ago';
import { InboxTable } from './inbox-table';
import { WaitingActions, WaitingDetail, WhoCell } from './waiting-row';

/** The With filter's "anyone" choice: no filter. */
const ANYONE = 'anyone';

/** The columns that sort, by the daemon's name for each. */
const SORTS: Readonly<Record<string, InboxSort>> = {
  title: InboxSort.Title,
  sentAt: InboxSort.SentAt,
};

const LONGEST_OUT_FIRST: DataTableSortStatus<InboxItemDto> = {
  columnAccessor: 'sentAt',
  direction: SortDirection.Asc,
};

/** The questions out with other people, as a table the daemon filters, sorts and pages. */
function WaitingTable({ project }: { readonly project: ProjectId | undefined }) {
  const now = useNow();
  const people = (usePeople().data ?? []).filter((p) => !p.isBuilder);
  const [person, setPerson] = useState<PersonId | null>(null);
  const [sort, setSort] = useState(LONGEST_OUT_FIRST);
  const [expanded, setExpanded] = useState<string[]>([]);
  const order = SORTS[String(sort.columnAccessor)] ?? InboxSort.SentAt;
  const paging = usePaging(
    JSON.stringify([project, person, order, sort.direction]),
    INBOX_PAGE_SIZE,
  );
  const waiting = useInboxPage({
    state: InboxListState.Waiting,
    ...(project === undefined ? {} : { project }),
    ...(person === null ? {} : { person }),
    sort: order,
    dir: sort.direction,
    page: paging.page,
    pageSize: paging.pageSize,
  });
  const answer = waiting.data;
  const columns: DataTableColumn<InboxItemDto>[] = [
    {
      accessor: 'with',
      title: 'With',
      width: 190,
      filtering: person !== null,
      filter: (
        <Select
          aria-label="With"
          size="xs"
          w={200}
          allowDeselect={false}
          checkIconPosition="right"
          // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
          comboboxProps={{ withinPortal: false }}
          data={[
            { value: ANYONE, label: 'Anyone' },
            ...people.map((p) => ({ value: p.id, label: p.name })),
          ]}
          value={person ?? ANYONE}
          onChange={(next) => {
            setPerson(people.find((p) => p.id === next)?.id ?? null);
          }}
        />
      ),
      render: (item) => <WhoCell item={item} />,
    },
    {
      accessor: 'title',
      title: 'Question',
      sortable: true,
      render: (item) => (
        <Text size="sm" fw={500} lineClamp={2} title={item.title}>
          {item.title}
        </Text>
      ),
    },
    {
      accessor: 'projectId',
      title: 'Project',
      width: 150,
      render: (item) => <ProjectLabel projectId={item.projectId} />,
    },
    {
      accessor: 'sentAt',
      title: 'How Long',
      width: 140,
      noWrap: true,
      sortable: true,
      render: (item) => {
        const send = item.send;
        return (
          <Stack gap={0}>
            {send?.sentAt == null ? null : (
              <Text size="sm" c="dimmed">{`sent ${shortAgo(send.sentAt, now)}`}</Text>
            )}
            {send?.remindedAt == null ? null : (
              <Text size="xs" c="dimmed">{`reminded ${shortAgo(send.remindedAt, now)}`}</Text>
            )}
          </Stack>
        );
      },
    },
    {
      accessor: 'actions',
      title: '',
      width: 100,
      render: (item) => (
        <WaitingActions
          item={item}
          onAnswerMyself={() => {
            setExpanded((open) => (open.includes(item.id) ? open : [...open, item.id]));
          }}
        />
      ),
    },
  ];
  return (
    <Stack gap="xs">
      {waiting.isError ? (
        <Alert color="red" title="Couldn't load the waiting questions">
          {waiting.error.message}
        </Alert>
      ) : null}
      <InboxTable<InboxItemDto>
        label="Waiting questions"
        records={answer?.items ?? []}
        columns={columns}
        sort={sort}
        onSort={setSort}
        paging={
          answer === undefined ? undefined : { ...paging, page: answer.page, total: answer.total }
        }
        fetching={waiting.isFetching && answer === undefined}
        empty={person === null ? 'Nothing is out with anyone.' : 'Nothing is out with them.'}
        expanded={expanded}
        onExpanded={setExpanded}
        detail={(item) => <WaitingDetail item={item} />}
      />
    </Stack>
  );
}

/**
 * The questions out with other people: nothing here needs the builder. Without a Slack connection
 * nobody can read a reply, so a sent question waits in Open instead and this view says so.
 */
export function WaitingInbox({ project }: { readonly project: ProjectId | undefined }) {
  const connection = useSlackConnection();
  if (connection.data === undefined) return null;
  if (connection.data.state !== 'connected')
    return <Text c="dimmed">Slack isn't connected, so questions sent there wait in Open.</Text>;
  return <WaitingTable project={project} />;
}
