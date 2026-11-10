import { PageRoute, REPORTED_ROUTES_MAX, routeUrl, type AppUrl } from '@10db/contracts';
import { pageRouteLoads } from '../pictures';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": what
// report_pages keeps of the routes an agent names. The browser loads each one signed in as the
// builder's dev login, so an agent must not be able to name any path at all: that would make 10db a
// confused deputy, doing a signed-in GET (one that changes data, say) the agent cannot do itself. A
// route is kept only as one of the project's page area routes: each parameter segment (`[id]`,
// `[...slug]`, `:id`) filled with one plain value that no page area's route uses as a literal segment
// at that depth, the reported query dropped and the area route's own query kept. A turn (a pass page)
// or a run (a task outside a pass) keeps at most REPORTED_ROUTES_MAX of them.

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

export interface ReportedRoutes {
  readonly accepted: string[];
  readonly refused: { readonly route: string; readonly reason: string }[];
}

/**
 * Judges `routes` for a turn or run that already keeps `kept`; `refusal` refuses every route with
 * why, for a task 10db takes no pictures of. A route kept already is accepted again and not counted.
 */
export function judgeReportedRoutes(input: {
  readonly appUrl: AppUrl | null;
  /** The routes of the project's page areas. */
  readonly areaRoutes: readonly string[];
  readonly refusal: string | null;
  readonly per: 'turn' | 'run';
  readonly kept: readonly string[];
  readonly routes: readonly string[];
}): ReportedRoutes {
  const accepted: string[] = [];
  const refused: { route: string; reason: string }[] = [];
  const kept = new Set(input.kept);
  for (const route of input.routes) {
    const refuse = (reason: string): void => {
      refused.push({ route, reason });
    };
    if (input.refusal !== null) refuse(input.refusal);
    else if (input.appUrl === null)
      refuse('This project has no app address, so 10db takes no pictures of it.');
    else if (!PageRoute.safeParse(route).success || routeUrl(input.appUrl, route) === null)
      refuse(
        'Not a path on the app: a route starts with one /, such as /people/42 or /people?tab=all, with no host, #, \\ or space.',
      );
    else if (!pageRouteLoads(route))
      refuse('Name the route with its parameter filled in, such as /people/42, not /people/[id].');
    else {
      const page = keptRoute(input.areaRoutes, route);
      if (page === null)
        refuse(
          `This is not a page area's route, so 10db does not load it: name a page area's route, each parameter one plain value of letters, digits, _ or - (${input.areaRoutes.join(', ') || 'this project has none'}).`,
        );
      else if (kept.has(page)) accepted.push(page);
      else if (kept.size >= REPORTED_ROUTES_MAX)
        refuse(
          `This ${input.per} already names four routes for its pictures, the most it may: this one is not loaded.`,
        );
      else {
        kept.add(page);
        accepted.push(page);
      }
    }
  }
  return { accepted: [...new Set(accepted)], refused };
}
