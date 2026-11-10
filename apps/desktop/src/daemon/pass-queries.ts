import {
  passHoldsTasks,
  SessionActivityData,
  type DaemonEvent,
  type PassId,
  type PassTurnId,
  type PassViewDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import type { QueryClient } from '@tanstack/react-query';

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

/** Writes a pass lane's `session.activity` into every cached pass that holds its page. */
export function writePassActivity(queryClient: QueryClient, event: DaemonEvent): void {
  const parsed = SessionActivityData.safeParse(event.data);
  if (!parsed.success || parsed.data.turn === null) return;
  const data = parsed.data;
  queryClient.setQueriesData<PassViewDto[]>({ queryKey: passKeys.live, exact: true }, (old) =>
    old?.map((view) => withActivity(view, data, event.at)),
  );
  queryClient.setQueriesData<PassViewDto>({ queryKey: passKeys.views }, (old) =>
    old ? withActivity(old, data, event.at) : old,
  );
}
