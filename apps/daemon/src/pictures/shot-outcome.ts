import { routeUrl } from '@10db/contracts';
import { ShotOutcome } from './camera';

/** What a page load gave, as the camera read it. */
export interface PageLoad {
  /** The navigation's error or timeout; null when it loaded. */
  readonly error: string | null;
  /** The page's URL after redirects; null when nothing loaded. */
  readonly landedUrl: string | null;
  /** The document's HTTP status; null when there was no response. */
  readonly status: number | null;
  /** The text of a dev server's error overlay over the page; null when none is up. */
  readonly overlayText: string | null;
}

export interface Outcome {
  readonly outcome: ShotOutcome;
  /** For `failed`: why. */
  readonly reason: string | null;
}

/** A path without the trailing slash an app may add or drop: `/people/` is `/people`. */
function bare(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function origin(raw: string): string {
  try {
    const { origin: o } = new URL(raw);
    // An opaque origin (`chrome-error://`, `about:`) prints as "null"; the address itself says more.
    return o === 'null' ? raw : o;
  } catch {
    return raw;
  }
}

/**
 * How a load went. In order: no page (an error, a timeout, nothing loaded) is `failed`; a page off the
 * app's origin is `failed` ("left the app's address"), never `elsewhere`, so a redirect to another port
 * neither counts as the app nor asks for a sign-in; another path of the app is `elsewhere`; an overlay
 * is `overlay`, even on a document that answered 500, since a dev server's build error answers so and
 * its text is what says what broke; a document that answered 500 or more is `failed`; else `clean`.
 */
export function shotOutcome(appUrl: string, route: string, load: PageLoad): Outcome {
  const asked = routeUrl(appUrl, route);
  if (asked === null) {
    return { outcome: ShotOutcome.Failed, reason: `${route} is not a route on ${appUrl}` };
  }
  if (load.error !== null) return { outcome: ShotOutcome.Failed, reason: load.error };
  if (load.landedUrl === null) {
    return { outcome: ShotOutcome.Failed, reason: 'the page never loaded' };
  }
  const landedOrigin = origin(load.landedUrl);
  if (landedOrigin !== appUrl) {
    return { outcome: ShotOutcome.Failed, reason: `left the app's address for ${landedOrigin}` };
  }
  if (bare(new URL(load.landedUrl).pathname) !== bare(new URL(asked).pathname)) {
    return { outcome: ShotOutcome.Elsewhere, reason: null };
  }
  if (load.overlayText !== null) return { outcome: ShotOutcome.Overlay, reason: null };
  if (load.status !== null && load.status >= 500) {
    return { outcome: ShotOutcome.Failed, reason: `the page answered ${String(load.status)}` };
  }
  return { outcome: ShotOutcome.Clean, reason: null };
}
