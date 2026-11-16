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

/** The name the builder reads a page by, such as "Plan": one line of 1 to 40 characters. */
export const PageLabel = z
  .string()
  .min(1, 'A label is at least one character')
  .max(40, 'A label is at most 40 characters')
  .refine(
    (t) => !/[\p{Cc}]/u.test(t),
    'A label is one line, with no control characters such as newlines or tabs',
  );
export type PageLabel = z.infer<typeof PageLabel>;

/**
 * What a page is called where the builder reads it: its label, else its name with the first letter
 * upper-cased. The name stays the key everywhere; this is display only.
 */
export function pageLabel(area: {
  readonly name: string;
  readonly label?: string | undefined;
}): string {
  return area.label ?? `${area.name.charAt(0).toUpperCase()}${area.name.slice(1)}`;
}

/** What the page rules read of an area. */
interface RoledArea {
  readonly name: string;
  readonly globs: readonly string[];
  readonly catchAll?: boolean | undefined;
  readonly role?: AreaRole | undefined;
  readonly route?: string | undefined;
  readonly label?: string | undefined;
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
  const labelled = areas.find((a) => a.label !== undefined && a.role !== AreaRole.Page);
  if (labelled !== undefined) return `Only a page has a label: "${labelled.name}" is not a page`;
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

/**
 * The globs of one area that holds every file of a repository, for a project nothing was proposed
 * for. Node's glob matcher, which 10db matches paths with, lets no `*` or `**` match a name that
 * starts with a dot, so dotfiles and the files below a dot folder have globs of their own. A file
 * below a second dot name, such as a dotfile in a dot folder, is still left out.
 */
export const WHOLE_REPOSITORY_GLOBS: readonly string[] = ['**', '**/.*', '**/.*/**'];

/**
 * The one page of a pass of one: the whole repository. Its name can't be spelled as an `AreaName` (it starts
 * with a digit), so no project area or hazard shares it, and it is never saved in `projects.areas`.
 */
export const WHOLE_PROJECT_PAGE: {
  readonly name: string;
  readonly globs: string[];
  readonly role: typeof AreaRole.Page;
  readonly label: string;
} = {
  name: '10db-whole-project',
  globs: [...WHOLE_REPOSITORY_GLOBS],
  role: AreaRole.Page,
  label: 'Whole project',
};

/** What `areaLabel` reads of an area. */
interface LabelledArea {
  readonly name: string;
  readonly label?: string | undefined;
}

/**
 * What an area or page is called where the builder reads it: the whole-project page's label, else the
 * area's own (`pageLabel`). A name no area has reads as it is spelled.
 */
export function areaLabel(name: string, areas: readonly LabelledArea[]): string {
  if (name === WHOLE_PROJECT_PAGE.name) return WHOLE_PROJECT_PAGE.label;
  const area = areas.find((a) => a.name === name);
  return area === undefined ? name : pageLabel(area);
}
