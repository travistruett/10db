import {
  AreaRole,
  BoardStatus,
  globsOverlap,
  PASS_PAGE_CAP_DEFAULT,
  PASS_PAGE_CAP_MAX,
  passHeldAreas,
  TaskStatus,
  WorkspaceMode,
  type AreaDef,
  type GoalId,
  type PassOpenRequest,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';

// Workbench spec §4.2: what the picker offers and what Start Pass sends. A row is a page area, or an
// open task that works on one; two ticked rows may not hold the same file.

/** An open Board task that can join a pass, named as the builder reads it. */
export interface JoinableTask {
  readonly taskId: TaskId;
  readonly title: string;
  /** The page areas it holds for its life in a pass. */
  readonly pages: readonly string[];
}

/** What is ticked: page areas to make a new task for, and open tasks to join. */
export interface PickTicks {
  readonly pages: readonly string[];
  readonly tasks: readonly JoinableTask[];
}

/** Board columns a task can join from: not started, not running and not shipped. */
const JOINS_FROM: ReadonlySet<BoardStatus> = new Set([BoardStatus.Backlog, BoardStatus.Ready]);

/**
 * The open tasks that can join a pass: in Your folder, not running, not shipped, in no pass yet, and
 * naming a page area. Work a task keeps from an earlier pass comes back with it.
 */
export function joinableTasks(
  tasks: readonly TaskDto[],
  areas: readonly AreaDef[],
): JoinableTask[] {
  const isPage = (name: string) => areas.some((a) => a.name === name && a.role === AreaRole.Page);
  return tasks.flatMap((task) => {
    if (task.status !== TaskStatus.Open || !JOINS_FROM.has(task.boardStatus)) return [];
    if (task.workspaceMode !== WorkspaceMode.Shared || (task.passId ?? null) !== null) return [];
    if (!task.areas.some(isPage)) return [];
    return [
      {
        taskId: task.id,
        title: task.headline === '' ? task.title : task.headline,
        pages: passHeldAreas(areas, task),
      },
    ];
  });
}

/** The first pair of globs, one of each area, that can match the same file; the catch-all shares none. */
function sharedGlobs(
  first: AreaDef | undefined,
  second: AreaDef | undefined,
): readonly [string, string] | null {
  if (!first || !second || first.catchAll === true || second.catchAll === true) return null;
  for (const a of first.globs) {
    const b = second.globs.find((glob) => globsOverlap(a, glob));
    if (b !== undefined) return [a, b];
  }
  return null;
}

/**
 * Why a row cannot be ticked beside what is, or null when it can: the pass is full, a ticked row
 * already holds one of its pages, or a ticked page can share a file with one of them (named with both
 * globs). Pass a ticked row the other ticks, so it is never blocked by itself.
 */
export function blockedReason(
  row: { readonly pages: readonly string[] },
  ticks: PickTicks,
  areas: readonly AreaDef[],
): string | null {
  if (ticks.pages.length + ticks.tasks.length >= PASS_PAGE_CAP_MAX)
    return `A pass holds at most ${String(PASS_PAGE_CAP_MAX)} pages`;
  const area = (name: string) => areas.find((a) => a.name === name);
  const holders = [
    ...ticks.pages.map((page) => ({ name: page, pages: [page], isTask: false })),
    ...ticks.tasks.map((task) => ({ name: task.title, pages: task.pages, isTask: true })),
  ];
  for (const holder of holders) {
    for (const page of row.pages) {
      if (holder.pages.includes(page))
        return holder.isTask ? `${holder.name} works on ${page}` : `${page} is ticked`;
      for (const held of holder.pages) {
        const globs = sharedGlobs(area(held), area(page));
        if (globs)
          return `${held} can share a file with it: ${globs[0]} and ${globs[1]} both match one`;
      }
    }
  }
  return null;
}

/** How many pages a pass's name lists before "n more" stands for the rest. */
const NAMED_PAGES = 3;

/** "Settings pass", "Settings and People pass", "Settings, People and 2 more pass". */
export function passName(pages: readonly string[]): string {
  const listed =
    pages.length <= NAMED_PAGES
      ? pages
      : [...pages.slice(0, NAMED_PAGES - 1), `${String(pages.length - NAMED_PAGES + 1)} more`];
  const last = listed.at(-1) ?? '';
  const head = listed.slice(0, -1);
  return `${head.length === 0 ? last : `${head.join(', ')} and ${last}`} pass`;
}

/** The pass holds the default number of pages, or every ticked one when more are. */
export function pageCap(ticked: number): number {
  return Math.max(PASS_PAGE_CAP_DEFAULT, ticked);
}

/** Start Pass's request: the ticked pages and tasks, the message only when one is written. */
export function openRequest(
  ticks: PickTicks,
  bothering: string,
  goalId: GoalId | null,
): PassOpenRequest {
  const firstMessage = bothering.trim();
  const names = [...ticks.pages, ...ticks.tasks.map((task) => task.pages[0] ?? task.title)];
  return {
    name: passName(names),
    pages: [...ticks.pages],
    taskIds: ticks.tasks.map((task) => task.taskId),
    pageCap: pageCap(names.length),
    ...(firstMessage === '' ? {} : { firstMessage }),
    ...(goalId === null ? {} : { goalId }),
  };
}
