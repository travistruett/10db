import type { DesignCheckShot } from '@10db/contracts';
import type { ShotsNow } from './pictures';

// What a design check keeps of a set of on-demand shots: one entry per route asked, the picture's hash or
// the reason there is none, and the same reasons as lines for the session that reads them.

/** The route's shot as a check keeps it: its hash, or why it is missing. */
export function checkShotsOf(routes: readonly string[], taken: ShotsNow): DesignCheckShot[] {
  const whole = taken.missing.find((m) => m.route === null)?.reason;
  return routes.map((route) => {
    const shot = taken.shots.find((s) => s.route === route);
    const reason =
      taken.missing.find((m) => m.route === route)?.reason ?? whole ?? 'the page was not shot';
    return {
      route,
      viewport: taken.viewport,
      theme: taken.theme,
      sha256: shot?.sha256 ?? null,
      missing: shot === undefined ? reason : null,
    };
  });
}

/** What is missing from the evidence, in lines: a route that has no picture, each with why. */
export function missingLines(routes: readonly string[], taken: ShotsNow): string[] {
  return checkShotsOf(routes, taken).flatMap((s) =>
    s.missing === null ? [] : [`${s.route} was not shot: ${s.missing}`],
  );
}
