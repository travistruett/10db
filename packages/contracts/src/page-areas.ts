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
 * The first two page areas that can share a file, or null. A file belongs to one page, so two pages
 * may not overlap; a page may overlap a shared area, whose claim never covers a page's files in a
 * pass. The catch-all is left out: it holds only files no other area matches, so it shares none.
 */
function pageOverlap(areas: readonly RoledArea[]): PageOverlap | null {
  const pages = areas.filter((a) => a.role === AreaRole.Page && a.catchAll !== true);
  for (const [n, first] of pages.entries()) {
    for (const second of pages.slice(n + 1)) {
      for (const firstGlob of first.globs) {
        const secondGlob = second.globs.find((g) => globsOverlap(firstGlob, g));
        if (secondGlob !== undefined)
          return { first: first.name, second: second.name, firstGlob, secondGlob };
      }
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
