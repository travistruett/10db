import { PageRoute, REPORTED_ROUTES_MAX, routeUrl, type AppUrl } from '@10db/contracts';
import { pageRouteLoads } from '../pictures';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": what
// report_pages keeps of the routes an agent names. The browser loads each one signed in as the
// builder's dev login, so an agent must not be able to name any path at all: that would make 10db a
// confused deputy, doing a signed-in GET (one that changes data, say) the agent cannot do itself. A
// route is kept only when it is one of the project's page area routes, a parameter segment (`[id]`,
// `[...slug]`, `:id`) standing for exactly one concrete segment, with any query kept. A turn (a pass
// page) or a run (a task outside a pass) keeps at most REPORTED_ROUTES_MAX of them.

/** An area route's segment that stands for a value: Next's `[id]` and `[...slug]`, or `:id`. */
const isParameter = (segment: string): boolean => segment.includes('[') || segment.startsWith(':');

/**
 * A concrete path segment as the app's router reads it, or null for one that could reach another
 * path: empty, `.` or `..` (encoded too), a slash or backslash once decoded, or a bad escape.
 */
function concreteSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded === '' || decoded === '.' || decoded === '..') return null;
  if (decoded.includes('/') || decoded.includes('\\')) return null;
  return decoded;
}

/** Whether `route` is the page area route `areaRoute`, each parameter one concrete segment; its query is kept. */
export function matchesAreaRoute(areaRoute: string, route: string): boolean {
  const [areaPath = ''] = areaRoute.split('?');
  const [path = ''] = route.split('?');
  const want = areaPath.split('/').slice(1);
  const got = path.split('/').slice(1);
  if (want.length !== got.length) return false;
  return want.every((segment, i) => {
    const raw = got[i] ?? '';
    const concrete = concreteSegment(raw);
    if (concrete === null) return false;
    if (isParameter(segment)) return !isParameter(raw);
    return concrete === segment;
  });
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
    else if (!input.areaRoutes.some((areaRoute) => matchesAreaRoute(areaRoute, route)))
      refuse(
        `This is not a page area's route, so 10db does not load it: name a page area's route, its parameters filled in (${input.areaRoutes.join(', ') || 'this project has none'}).`,
      );
    else if (kept.has(route)) accepted.push(route);
    else if (kept.size >= REPORTED_ROUTES_MAX)
      refuse(
        `This ${input.per} already names four routes for its pictures, the most it may: this one is not loaded.`,
      );
    else {
      kept.add(route);
      accepted.push(route);
    }
  }
  return { accepted: [...new Set(accepted)], refused };
}
