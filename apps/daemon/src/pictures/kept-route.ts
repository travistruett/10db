import { AreaRole, type AreaDef } from '@10db/contracts';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": the
// browser loads a route an agent reports signed in as the builder's dev login, so it loads one only as
// a page area's route, never any path the agent names: each parameter segment (`[id]`, `[...slug]`,
// `:id`) filled with one plain value that no page area's route uses as a literal segment at that depth,
// the reported query dropped and the area route's own query kept.

/** An area route's segment that stands for a value: Next's `[id]` and `[...slug]`, or `:id`. */
const isParameter = (segment: string): boolean => segment.includes('[') || segment.startsWith(':');

/** A value a parameter may take: plain letters, digits, `_` and `-`, so it can never reach another path. */
const PARAMETER_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

const pathOf = (route: string): string[] => (route.split('?')[0] ?? '').split('/').slice(1);

/**
 * The route the browser loads for `route`, when it is one of the page area routes `areaRoutes`; null
 * otherwise. Its query is dropped and the matching area route's own query kept.
 */
export function keptRoute(areaRoutes: readonly string[], route: string): string | null {
  const got = pathOf(route);
  // A value equal to a literal segment of any page at the same depth may be that page, not a value.
  const literals = areaRoutes.flatMap((r) =>
    pathOf(r).flatMap((segment, depth) =>
      isParameter(segment) ? [] : [`${String(depth)}:${segment}`],
    ),
  );
  for (const areaRoute of areaRoutes) {
    const want = pathOf(areaRoute);
    if (want.length !== got.length) continue;
    const matches = want.every((segment, depth) => {
      const value = got[depth] ?? '';
      return isParameter(segment)
        ? PARAMETER_VALUE.test(value) && !literals.includes(`${String(depth)}:${value}`)
        : value === segment;
    });
    if (!matches) continue;
    const query = areaRoute.includes('?') ? areaRoute.slice(areaRoute.indexOf('?')) : '';
    return `/${got.join('/')}${query}`;
  }
  return null;
}

/** The routes of the project's page areas. */
export function pageAreaRoutes(areas: readonly Pick<AreaDef, 'role' | 'route'>[]): string[] {
  return areas.flatMap((a) => (a.role === AreaRole.Page && a.route !== undefined ? [a.route] : []));
}
