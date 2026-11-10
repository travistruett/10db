import { PageRoute, REPORTED_ROUTES_MAX, routeUrl, type AppUrl } from '@10db/contracts';
import { pageRouteLoads } from '../pictures';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": what
// report_pages keeps of the routes an agent names. Each is a path on the app's address that the
// browser can load as it stands; a turn (a pass page) or a run (a task outside a pass) keeps at most
// REPORTED_ROUTES_MAX of them.

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
