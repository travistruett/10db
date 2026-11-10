import {
  AreaRole,
  PageRoute,
  WorkspaceMode,
  type AreaDef,
  type PassSharedChangeDto,
  type PassTurnDto,
  type ProjectDto,
  type ScreenTheme,
  type ScreenViewport,
  type TaskDto,
} from '@10db/contracts';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages", "When"
// and "How": which tasks take pictures, of which routes, and which turns are worth one.

/** One picture to take: a route in one viewport and theme. */
export interface PictureTarget {
  readonly route: string;
  readonly viewport: ScreenViewport;
  readonly theme: ScreenTheme;
}

type RoutedProject = Pick<ProjectDto, 'appUrl' | 'screens'> & {
  readonly areas: readonly Pick<AreaDef, 'name' | 'role' | 'route'>[];
};

/** A route the browser can load as it stands: a path with no parameter segment (`[id]`, `:id`). */
const loads = (route: string): boolean =>
  PageRoute.safeParse(route).success &&
  !route
    .split('?')[0]
    ?.split('/')
    .some((segment) => segment.includes('[') || segment.startsWith(':'));

/** The routes of the page areas the task names that load, each in every viewport and theme. */
export function pictureRoutes(
  project: RoutedProject,
  task: Pick<TaskDto, 'areas'>,
): PictureTarget[] {
  if (project.appUrl === null) return [];
  const routes = project.areas
    .filter((a) => a.role === AreaRole.Page && task.areas.includes(a.name))
    .flatMap((a) => (a.route !== undefined && loads(a.route) ? [a.route] : []));
  return [...new Set(routes)].flatMap((route) =>
    project.screens.viewports.flatMap((viewport) =>
      project.screens.themes.map((theme) => ({ route, viewport, theme })),
    ),
  );
}

/** Whether pictures are taken of the task: a page of a pass, or a Your-folder task naming a routed page. */
export function takesPictures(
  project: RoutedProject,
  task: Pick<TaskDto, 'areas' | 'passId' | 'workspaceMode'>,
): boolean {
  if (task.passId != null) return true;
  return task.workspaceMode === WorkspaceMode.Shared && pictureRoutes(project, task).length > 0;
}

/**
 * Whether a turn changed something the page shows: a new kept commit, or a shared change the task kept
 * from a hold granted during the turn.
 */
export function turnChangedSomething(
  turn: Pick<PassTurnDto, 'taskId' | 'keptSha' | 'sharedSeq'>,
  previous: Pick<PassTurnDto, 'keptSha' | 'sharedSeq'> | undefined,
  sharedChanges: readonly Pick<PassSharedChangeDto, 'taskId' | 'seq' | 'dropOf'>[],
): boolean {
  if (turn.keptSha !== null && turn.keptSha !== (previous?.keptSha ?? null)) return true;
  const after = previous?.sharedSeq ?? Number.NEGATIVE_INFINITY;
  const upTo = turn.sharedSeq ?? Number.NEGATIVE_INFINITY;
  return sharedChanges.some(
    (c) => c.taskId === turn.taskId && c.dropOf === null && c.seq > after && c.seq <= upTo,
  );
}
