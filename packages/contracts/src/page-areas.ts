import { z } from 'zod';
import { globsOverlap } from './glob-overlap';

/**
 * What an area is to the project's app. A `page` is a screen the builder looks at, held by one task
 * for the task's life. A `shared` area is code many pages use (components, global styles, public
 * assets). An area with neither behaves as it always has.
 */
export const AreaRole = { Page: 'page', Shared: 'shared' } as const;
export type AreaRole = (typeof AreaRole)[keyof typeof AreaRole];

/** The path in the project's app that shows a page, such as `/people`: one line, no spaces. */
export const AreaRoute = z
  .string()
  .max(500)
  .startsWith('/', 'A route is a path that starts with /, such as /people')
  .refine((r) => !/[\s\p{Cc}]/u.test(r), 'A route has no spaces or control characters');

/** What the page rules read of an area. */
interface RoledArea {
  readonly name: string;
  readonly globs: readonly string[];
  readonly catchAll?: boolean | undefined;
  readonly role?: AreaRole | undefined;
  readonly route?: string | undefined;
}

/** Two page areas and the glob of each that can match the same file. */
interface PageOverlap {
  readonly first: string;
  readonly second: string;
  readonly firstGlob: string;
  readonly secondGlob: string;
}

/**
 * The globs of two areas that can match the same file, or null. The catch-all is left out: it holds
 * only files no other area matches, so it shares none.
 */
function areasOverlap(first: RoledArea, second: RoledArea): PageOverlap | null {
  if (first.catchAll === true || second.catchAll === true) return null;
  for (const firstGlob of first.globs) {
    const secondGlob = second.globs.find((g) => globsOverlap(firstGlob, g));
    if (secondGlob !== undefined)
      return { first: first.name, second: second.name, firstGlob, secondGlob };
  }
  return null;
}

/**
 * The first two page areas that can share a file, or null. A file belongs to one page, so two pages
 * may not overlap; a page may overlap a shared area, whose claim never covers a page's files in a
 * pass.
 */
function pageOverlap(areas: readonly RoledArea[]): PageOverlap | null {
  const pages = areas.filter((a) => a.role === AreaRole.Page);
  for (const [n, first] of pages.entries()) {
    for (const second of pages.slice(n + 1)) {
      const overlap = areasOverlap(first, second);
      if (overlap !== null) return overlap;
    }
  }
  return null;
}

/** What is wrong with the areas' roles and routes, in words, or null when nothing is. */
export function areaRolesProblem(areas: readonly RoledArea[]): string | null {
  const routed = areas.find((a) => a.route !== undefined && a.role !== AreaRole.Page);
  if (routed !== undefined) return `Only a page has a route: "${routed.name}" is not a page`;
  const overlap = pageOverlap(areas);
  if (overlap === null) return null;
  return (
    `Pages "${overlap.first}" and "${overlap.second}" can share a file: ` +
    `${overlap.firstGlob} and ${overlap.secondGlob} both match one. ` +
    'A file belongs to one page, so narrow one of them or mark it shared'
  );
}

/** What the pass rules read of a task. */
interface PassTask {
  readonly title: string;
  readonly areas: readonly string[];
}

/**
 * The areas a task in a pass holds for its life, claimed when the pass opens: its pages, and any
 * area with no role, which a pass holds as a page. A shared area is asked for a turn at a time, and a
 * name that is no area (a hazard) is held as it is outside a pass.
 */
export function passHeldAreas(
  areas: readonly RoledArea[],
  task: Pick<PassTask, 'areas'>,
): string[] {
  return task.areas.filter((name) => {
    const area = areas.find((a) => a.name === name);
    return area !== undefined && area.role !== AreaRole.Shared;
  });
}

/**
 * Why these tasks cannot open a pass together, in words, or null: each must name a page area, and
 * no two may hold the same area or areas that can share a file, since a file belongs to one task. An
 * area with no role is held for the task's life as a page is, so it counts as one here.
 */
export function passPagesProblem(
  areas: readonly RoledArea[],
  tasks: readonly PassTask[],
): string | null {
  const isPage = (name: string): boolean =>
    areas.some((a) => a.name === name && a.role === AreaRole.Page);
  for (const task of tasks)
    if (!task.areas.some(isPage))
      return `${task.title} names no page area; a task in a pass works on at least one page`;
  for (const [n, first] of tasks.entries()) {
    for (const second of tasks.slice(n + 1)) {
      const held = passHeldAreas(areas, second);
      const same = passHeldAreas(areas, first).find((name) => held.includes(name));
      if (same !== undefined)
        return `"${first.title}" and "${second.title}" both hold ${same}; a file belongs to one task in a pass`;
      const heldOf = (task: PassTask) => {
        const names = passHeldAreas(areas, task);
        return areas.filter((a) => names.includes(a.name));
      };
      for (const one of heldOf(first)) {
        for (const other of heldOf(second)) {
          const overlap = areasOverlap(one, other);
          if (overlap !== null)
            return (
              `"${first.title}" and "${second.title}" hold areas that can share a file: ` +
              `${overlap.firstGlob} and ${overlap.secondGlob} both match one`
            );
        }
      }
    }
  }
  return null;
}
