import {
  InboxCardContextDto,
  InboxPageDto,
  InboxKind,
  type InboxItemDto,
  type InboxItemId,
  type InboxPageQuery,
  type InboxRowSort,
  type PassId,
} from '@10db/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRenderMode } from '../screens/render-context';
import { readJson, type DaemonClient } from './client';
import { flattenRows, joinRows } from './inbox-live';
import { useDaemon } from './provider';
import { useInboxPage } from './queries';

/** What a list of rows is filtered by; the page and the cursor are the query's own. */
export type InboxList = Omit<
  InboxPageQuery,
  'after' | 'page' | 'pageSize' | 'sort' | 'dir' | 'card'
>;

/** One row of a list: a card, identical flags shown together, or a pass's Ready pages. */
export interface InboxRow {
  /** What selection and drafts follow: it stays the same while members leave the row. */
  readonly key: string;
  readonly sort: InboxRowSort;
  /** The Workbench pass whose Ready pages the row holds; null for any other row. */
  readonly passId: PassId | null;
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
}

export interface InboxRowsPage {
  readonly rows: readonly InboxRow[];
  /** `after` for the page below this one; null on the last. */
  readonly next: InboxRowSort | null;
}

export const INBOX_ROWS_PAGE = 50;

/** Outside `['inbox']`, so an entity event never refetches a whole list: `applyInboxEvent` patches it instead. */
export const inboxRowsKey = (list: InboxList) => ['inbox-rows', list] as const;

/**
 * The typed client reads the route's parsed query, where `after` is the tuple; the wire carries its JSON text,
 * which the route parses.
 */
function afterParam(after: InboxRowSort): { after: InboxRowSort } {
  // A validated boundary: the route's schema parses this text back into the tuple.
  return { after: JSON.stringify(after) as unknown as InboxRowSort };
}

async function fetchRows(
  client: DaemonClient,
  list: InboxList,
  paging: {
    readonly pageSize: number;
    readonly after?: InboxRowSort | null;
    readonly card?: InboxItemId;
  },
): Promise<InboxRowsPage> {
  const page = await readJson(
    await client.inbox.page.$get({
      query: {
        state: list.state,
        pageSize: String(paging.pageSize),
        ...(list.project === undefined ? {} : { project: list.project }),
        ...(list.kind === undefined ? {} : { kind: list.kind }),
        ...(list.outcome === undefined ? {} : { outcome: list.outcome }),
        ...(list.person === undefined ? {} : { person: list.person }),
        ...(list.q === undefined ? {} : { q: list.q }),
        ...(list.since === undefined ? {} : { since: list.since }),
        ...(paging.after == null ? {} : afterParam(paging.after)),
        ...(paging.card === undefined ? {} : { card: paging.card }),
      },
    }),
    InboxPageDto,
  );
  return joinRows(page);
}

/** The row `card` is in within `list` now, or null when the list does not hold it. */
export async function fetchRowOf(
  client: DaemonClient,
  list: InboxList,
  card: InboxItemId,
): Promise<InboxRow | null> {
  const page = await fetchRows(client, list, { pageSize: 1, card });
  return page.rows[0] ?? null;
}

/**
 * A list of rows that pages by cursor as it is scrolled. A frame drawn for a session asks for that session's
 * project only (§5.5), whatever project the list names.
 */
export function useInboxRows(list: InboxList) {
  const { client } = useDaemon();
  const renderProject = useRenderMode()?.projectId;
  const asked: InboxList = renderProject === undefined ? list : { ...list, project: renderProject };
  const query = useInfiniteQuery({
    queryKey: inboxRowsKey(asked),
    initialPageParam: null as InboxRowSort | null,
    queryFn: ({ pageParam }) =>
      fetchRows(client, asked, { pageSize: INBOX_ROWS_PAGE, after: pageParam }),
    getNextPageParam: (page) => page.next,
    placeholderData: keepPreviousData,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  return {
    rows: flattenRows(query.data?.pages ?? []),
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    loadMore: () => {
      if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
    },
    isPending: query.isPending,
    /** The rows are the previous list's, kept until the new list's first page arrives. */
    isPlaceholder: query.isPlaceholderData,
    error: query.isFetchNextPageError ? null : query.error,
    moreError: query.isFetchNextPageError ? query.error : null,
  };
}

/**
 * How many rows a state holds, with no filters: the daemon's total, so no list loads for a badge. It stays
 * under `['inbox']`, so every inbox event refreshes it. Undefined while it loads.
 */
export function useInboxCount(state: 'open' | 'waiting'): number | undefined {
  return useInboxPage({ state, pageSize: 1 }).data?.total;
}

/** The read of a question's last messages; a card of another kind has none, so the query is off. */
export function cardContextQuery(client: DaemonClient, item: InboxItemDto | null) {
  const id = item?.kind === InboxKind.Question ? item.id : null;
  return {
    queryKey: ['inbox-card-context', id],
    queryFn: async () =>
      readJson(
        await client.inbox[':id'].context.$get({ param: { id: id ?? '' } }),
        InboxCardContextDto,
      ),
    enabled: id !== null,
    staleTime: Infinity,
  };
}

/** The last messages of a question's task conversation, for the row's content. Other kinds have none. */
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto> {
  const { client } = useDaemon();
  return useQuery(cardContextQuery(client, item));
}
