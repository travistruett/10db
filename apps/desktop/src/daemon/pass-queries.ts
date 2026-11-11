import {
  GoalPassPagesDto,
  PASS_RETRY_TURN_CHOICE,
  PassAbandonedDto,
  PassDto,
  passHoldsTasks,
  PassOpenedDto,
  PassStartDto,
  PassTurnWithFilesDto,
  PassViewDto,
  SessionActivityData,
  TakeOutResultDto,
  TaskMessageDto,
  TurnActivityDto,
  WorkbenchSetupDto,
  type DaemonEvent,
  type GoalId,
  type InboxItemId,
  type PassId,
  type PassJoinRequest,
  type PassOpenRequest,
  type PassRename,
  type PassTurnId,
  type ProjectId,
  type SharedChoice,
  type TaskId,
} from '@10db/contracts';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';
import { queryKeys } from './queries';
import { threadKeys, type TaskMessageSend } from './thread-queries';

// Workbench spec §4.3: the passes the Workbench reads. Every pass event refetches them; a pass lane's
// tool calls are written into its page's turn as they come, never refetched one by one.

export const passKeys = {
  all: ['passes'],
  /** `GET /passes?live=true`: every project's live passes. */
  live: ['passes', 'live'],
  views: ['passes', 'view'],
  /** `GET /passes/:passId`. */
  view: (passId: PassId) => ['passes', 'view', passId] as const,
  turnsAll: ['passes', 'turns'],
  /** `GET /tasks/:taskId/turns`. */
  turns: (taskId: TaskId) => ['passes', 'turns', taskId] as const,
  /** `GET /pass-turns/:turnId/activity`: a turn's log. */
  activity: (turnId: PassTurnId) => ['passes', 'activity', turnId] as const,
  /** `GET /projects/:projectId/pass-start`: under `all`, so a pass opening or a page leaving reads it again. */
  start: (projectId: ProjectId) => ['passes', 'start', projectId] as const,
  /** `GET /goals/:goalId/pass-pages`. */
  goalPages: (goalId: GoalId) => ['passes', 'goal-pages', goalId] as const,
} as const;

/**
 * The project's pass the Workbench shows: the one that holds its tasks (open, closing or
 * abandoning), else the latest closed one still waiting to settle; null with neither.
 */
export function livePassOf(
  passes: readonly PassViewDto[],
  projectId: ProjectId,
): PassViewDto | null {
  const mine = passes.filter((view) => view.pass.projectId === projectId);
  const holding = mine.find((view) => passHoldsTasks(view.pass.state));
  if (holding) return holding;
  return mine.reduce<PassViewDto | null>(
    (latest, view) =>
      latest === null || view.pass.openedAt > latest.pass.openedAt ? view : latest,
    null,
  );
}

/** The pass with its page's turn saying what the activity reports; the same object when no page matches. */
export function withActivity(
  view: PassViewDto,
  data: SessionActivityData,
  at: string,
): PassViewDto {
  const turn = data.turn;
  if (turn === null) return view;
  const matches = (page: PassViewDto['pages'][number]) =>
    page.workstreamId === data.workstreamId && page.turn?.id === turn.id;
  if (!view.pages.some(matches)) return view;
  return {
    ...view,
    pages: view.pages.map((page) =>
      page.turn === null || !matches(page)
        ? page
        : {
            ...page,
            turn: {
              ...page.turn,
              activity: {
                tool: data.tool?.name ?? null,
                target: data.tool?.target ?? null,
                filesTouched: turn.filesTouched,
                at,
              },
            },
          },
    ),
  };
}

/**
 * Writes a pass lane's `session.activity` into every cached pass that holds its page, and marks its
 * turn's log stale.
 */
export function writePassActivity(queryClient: QueryClient, event: DaemonEvent): void {
  const parsed = SessionActivityData.safeParse(event.data);
  if (!parsed.success || parsed.data.turn === null) return;
  const data = parsed.data;
  const turnId = parsed.data.turn.id;
  queryClient.setQueriesData<PassViewDto[]>({ queryKey: passKeys.live, exact: true }, (old) =>
    old?.map((view) => withActivity(view, data, event.at)),
  );
  queryClient.setQueriesData<PassViewDto>({ queryKey: passKeys.views }, (old) =>
    old ? withActivity(old, data, event.at) : old,
  );
  // The turn's log grows by this row: only an open log reads it again.
  void queryClient.invalidateQueries({ queryKey: passKeys.activity(turnId) });
}

const PassViewList = z.array(PassViewDto);
const TurnList = z.array(PassTurnWithFilesDto);
const ActivityList = z.array(TurnActivityDto);

/** `GET /passes?live=true`, for a hook or a one-off read. */
export function livePassesOptions(client: DaemonClient) {
  return queryOptions({
    queryKey: passKeys.live,
    queryFn: async () =>
      readJson(await client.passes.$get({ query: { live: 'true' } }), PassViewList),
  });
}

/** The project's pass the Workbench shows (`livePassOf`): null with none, undefined until read. */
export function useLivePass(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    ...livePassesOptions(client),
    select: (passes) => livePassOf(passes, projectId),
  });
}

/** What Start Pass and Add Page offer: the project's pages, what is changed in them, what it lacks. */
export function usePassStart(projectId: ProjectId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    enabled,
    queryKey: passKeys.start(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['pass-start'].$get({
          param: { projectId },
        }),
        PassStartDto,
      ),
  });
}

/** The pages a goal's tasks committed in, which Work on This starts the picker with; none without a goal. */
export function useGoalPassPages(goalId: GoalId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: goalId === null ? ['passes', 'goal-pages', 'none'] : passKeys.goalPages(goalId),
    queryFn: async () =>
      goalId === null
        ? GoalPassPagesDto.parse({ pages: [], fromTasks: [] })
        : readJson(
            await client.goals[':goalId']['pass-pages'].$get({
              param: { goalId },
            }),
            GoalPassPagesDto,
          ),
    enabled: goalId !== null,
  });
}

/** A page's turns with the files each changed, oldest first. */
export function useTurns(taskId: TaskId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: passKeys.turns(taskId),
    queryFn: async () =>
      readJson(
        await client.tasks[':taskId'].turns.$get({
          param: { taskId },
        }),
        TurnList,
      ),
  });
}

/** A turn's log, oldest first: what its session did. Read only while `enabled` (the log is open). */
export function useTurnActivity(turnId: PassTurnId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    enabled,
    queryKey: passKeys.activity(turnId),
    queryFn: async () =>
      readJson(
        await client['pass-turns'][':turnId'].activity.$get({ param: { turnId } }),
        ActivityList,
      ),
  });
}

/** A mutation that reads the passes, and then these, again once it lands. */
function useRefetchAfter(...more: readonly QueryKey[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [passKeys.all, ...more].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

/** Start Pass: opens a pass on the ticked pages and tasks. */
export function useOpenPass(projectId: ProjectId) {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(['tasks']);
  return useMutation({
    mutationFn: async (request: PassOpenRequest) =>
      readJson(
        await client.projects[':projectId'].passes.$post({ param: { projectId }, json: request }),
        PassOpenedDto,
      ),
    onSuccess: refetch,
  });
}

/** Add Page: new tasks for pages, and open tasks joining the pass. */
export function useAddPages() {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(['tasks']);
  return useMutation({
    mutationFn: async ({ passId, request }: { passId: PassId; request: PassJoinRequest }) =>
      readJson(
        await client.passes[':passId'].pages.$post({
          param: { passId },
          json: request,
        }),
        PassViewDto,
      ),
    onSuccess: refetch,
  });
}

export function useRenamePass() {
  const { client } = useDaemon();
  const refetch = useRefetchAfter();
  return useMutation({
    mutationFn: async ({ passId, body }: { passId: PassId; body: PassRename }) =>
      readJson(
        await client.passes[':passId'].$patch({
          param: { passId },
          json: body,
        }),
        PassDto,
      ),
    onSuccess: refetch,
  });
}

/** Abandon Pass: every unsigned page goes back, its task keeping the work. */
export function useAbandonPass() {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(['tasks'], queryKeys.inbox);
  return useMutation({
    mutationFn: async (passId: PassId) =>
      readJson(
        await client.passes[':passId'].abandon.$post({ param: { passId } }),
        PassAbandonedDto,
      ),
    onSuccess: refetch,
  });
}

/**
 * Take Out: the page leaves the pass, its work kept with its task, each of its unlanded shared changes
 * kept or dropped as `shared` says; one not named is kept.
 */
export function useTakeOutPage() {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(['tasks'], queryKeys.inbox);
  return useMutation({
    mutationFn: async ({
      passId,
      taskId,
      shared,
    }: {
      passId: PassId;
      taskId: TaskId;
      shared: readonly SharedChoice[];
    }) =>
      readJson(
        await client.passes[':passId'].tasks[':taskId']['take-out'].$post({
          param: { passId, taskId },
          json: { shared: [...shared] },
        }),
        TakeOutResultDto,
      ),
    onSuccess: refetch,
  });
}

/** `POST /projects/:projectId/workbench-setup`: read again once Apply saves the project. */
export const setupKeys = {
  of: (projectId: ProjectId) => ['workbench-setup', projectId] as const,
};

/**
 * The Workbench setup: the project's areas rebuilt and the settings 10db suggests. Leaving the screen
 * aborts the request, which stops the daemon's reading; a failure is shown, not retried.
 */
export function useWorkbenchSetup(projectId: ProjectId, enabled = true) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: setupKeys.of(projectId),
    queryFn: async ({ signal }) =>
      readJson(
        await client.projects[':projectId']['workbench-setup'].$post(
          { param: { projectId } },
          { init: { signal } },
        ),
        WorkbenchSetupDto,
      ),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

/** A plain Stop: the page's turn ends and nothing is sent; the page waits for the next message. */
export function useStopPage(taskId: TaskId) {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(threadKeys.of(taskId));
  return useMutation({
    mutationFn: async () =>
      readJson(await client.tasks[':taskId'].stop.$post({ param: { taskId } }), z.null()),
    onSuccess: refetch,
  });
}

/** Stop and Redo: the page's turn stops, then the builder's message starts the next. */
export function useRedoTurn(taskId: TaskId) {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(threadKeys.of(taskId));
  return useMutation({
    mutationFn: async ({ text, pictures }: TaskMessageSend) =>
      readJson(
        await client.tasks[':taskId'].thread.redo.$post({
          param: { taskId },
          form: { text, picture: [...pictures] },
        }),
        TaskMessageDto,
      ),
    onSuccess: refetch,
  });
}

/** Retry Turn: answers the failed turn's flag, which sends the builder's last message again. */
export function useRetryTurn() {
  const { client } = useDaemon();
  const refetch = useRefetchAfter(queryKeys.inbox, ['workstreams']);
  return useMutation({
    mutationFn: async (itemId: InboxItemId) =>
      readJson(
        await client.inbox[':id'].answer.$post({
          param: { id: itemId },
          json: { choice: PASS_RETRY_TURN_CHOICE },
        }),
        z.unknown(),
      ),
    onSuccess: refetch,
  });
}

/** Marks a Ready turn opened: the builder has looked at it, which the timing hint reads. */
export function useMarkOpened(taskId: TaskId) {
  const { client } = useDaemon();
  const refetch = useRefetchAfter();
  return useMutation({
    // What it answers is not read: the pass view, read again, carries the mark.
    mutationFn: async (turnId: PassTurnId) =>
      readJson(
        await client.tasks[':taskId'].turns[':turnId'].opened.$post({
          param: { taskId, turnId },
        }),
        z.unknown(),
      ),
    onSuccess: refetch,
  });
}

/** Discard Saved Work: drops the work a task kept from a pass, which its next start would put back. */
export function useDiscardKeptWork(taskId: TaskId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.tasks[':taskId']['kept-work'].$delete({
          param: { taskId },
        }),
        z.null(),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
