import { PageRoute, REPORTED_ROUTES_MAX, routeUrl, type AppUrl } from '@10db/contracts';
import { keptRoute, pageRouteLoads } from '../pictures';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": what
// report_pages keeps of the routes an agent names. The browser loads each one signed in as the
// builder's dev login, so an agent must not be able to name any path at all: that would make 10db a
// confused deputy, doing a signed-in GET (one that changes data, say) the agent cannot do itself. A
// route is kept only as a page area's route (`keptRoute`). A turn (a pass page) or a run (a task
// outside a pass) keeps at most REPORTED_ROUTES_MAX of them.

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
