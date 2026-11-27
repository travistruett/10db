import {
  ActivityPageDto,
  type ActivityPageQuery,
  type ActivityRow,
  type Notice,
  type TaskId,
} from '@10db/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

/** What a list of notices is filtered by; the page and the cursor are the query's own. */
export type ActivityList = Omit<ActivityPageQuery, 'after' | 'pageSize'>;

/** Every Activity read, so one `notice.posted` event refetches the lists and the drawers' notices. */
export const activityKeys = {
  all: ['activity'] as const,
  list: (list: ActivityList) => ['activity', list] as const,
};

const ACTIVITY_ROWS_PAGE = 50;
const TASK_NOTICES_PAGE = 20;

async function fetchActivity(
  client: DaemonClient,
  list: ActivityList,
  paging: { readonly pageSize: number; readonly after?: number | null },
): Promise<ActivityPageDto> {
  return readJson(
    await client.activity.page.$get({
      query: {
        pageSize: String(paging.pageSize),
        ...(list.project === undefined ? {} : { project: list.project }),
        ...(list.task === undefined ? {} : { task: list.task }),
        ...(list.q === undefined ? {} : { q: list.q }),
        ...(list.decided === undefined ? {} : { decided: list.decided }),
        ...(paging.after == null ? {} : { after: paging.after }),
      },
    }),
    ActivityPageDto,
  );
}

/**
 * Notices newest first, 50 a page by the last page's cursor. The rows stay until a changed search or filter's
 * first page arrives. The return shape is `useInboxRows`'s, so `InboxRowList` takes it as is.
 */
export function useActivityRows(list: ActivityList) {
  const { client } = useDaemon();
  const query = useInfiniteQuery({
    queryKey: activityKeys.list(list),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchActivity(client, list, { pageSize: ACTIVITY_ROWS_PAGE, after: pageParam }),
    getNextPageParam: (page) => page.next,
    placeholderData: keepPreviousData,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const rows: readonly ActivityRow[] = (query.data?.pages ?? []).flatMap((page) => page.rows);
  return {
    rows,
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
 * Undo takes back the decision a row reports; the daemon refuses (409) one that can't be undone or already was,
 * and the refusal's words show on the row.
 */
export function useUndoActivity() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async (seq: number) => {
      await readJson(
        await client.activity[':seq'].undo.$post({ param: { seq: String(seq) } }),
        z.null(),
      );
    },
    // The row now says undone, and the move's own notice joins the list.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: activityKeys.all }),
  });
}

/** Ask Me Next Time sets a row's rule to ask in its project, or, with `asking` false, back to deciding. */
export function useAskNextTime() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async (input: { readonly seq: number; readonly asking: boolean }) => {
      const param = { seq: String(input.seq) };
      await readJson(
        input.asking
          ? await client.activity[':seq']['ask-next-time'].$put({ param })
          : await client.activity[':seq']['ask-next-time'].$delete({ param }),
        z.null(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: activityKeys.all }),
  });
}

/** A task's latest notices as the drawer draws them; none, and no request, without a task. */
export function useTaskNotices(taskId: TaskId | null): readonly Notice[] {
  const { client } = useDaemon();
  const list: ActivityList = taskId === null ? {} : { task: taskId };
  const query = useQuery({
    queryKey: [...activityKeys.list(list), 'task-notices'],
    queryFn: () => fetchActivity(client, list, { pageSize: TASK_NOTICES_PAGE }),
    enabled: taskId !== null,
  });
  return (query.data?.rows ?? []).map((row) => ({
    key: `activity:${String(row.seq)}`,
    tone: row.tone,
    line: row.count > 1 ? `${row.line} ×${String(row.count)}` : row.line,
    body: row.body,
  }));
}
