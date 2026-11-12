import type { AppUrl, DevUiHandOff, ScreenTheme, ScreenViewport } from '@10db/contracts';
import type { StorageState } from './storage-state';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §13: the seam between
// what takes pictures and the browser. A `PageCamera` is the only thing that touches Playwright; the
// queue, the sign-in and the service above it are built against this interface.

/** The browser's readiness; `fetching` carries a promise that settles once the pinned build is ready or refused. */
export type BrowserStatus =
  | { readonly state: 'off' | 'ready'; readonly problem: null }
  | { readonly state: 'fetching'; readonly problem: null; readonly ready: Promise<boolean> }
  | { readonly state: 'refused'; readonly problem: string };

/**
 * How a load went: the page as asked (`clean`), the page under a dev server's error overlay
 * (`overlay`), no page (`failed`, a landing off the app's origin included), another page of the app
 * (`elsewhere`, such as a sign-in page), or nothing answering at the app's address at all
 * (`no_answer`: its dev server is not running).
 */
export const ShotOutcome = {
  Clean: 'clean',
  Overlay: 'overlay',
  Failed: 'failed',
  Elsewhere: 'elsewhere',
  NoAnswer: 'no_answer',
} as const;
export type ShotOutcome = (typeof ShotOutcome)[keyof typeof ShotOutcome];

export interface Shot {
  readonly outcome: ShotOutcome;
  /** The viewport's PNG; for `clean` and `overlay` only. */
  readonly png: Uint8Array | null;
  readonly width: number;
  readonly height: number;
  /** The page's URL after redirects, origin included. */
  readonly landedUrl: string | null;
  /** At most 4 KB of the overlay's text. */
  readonly overlayText: string | null;
  /** For `failed`: the navigation error or the status. */
  readonly reason: string | null;
  /**
   * The browser failed the load, not the app: refused, past the shot's own deadline, stuck, or given no
   * route. Such a load says nothing about the page, so it never counts as a broken preview.
   */
  readonly cameraFailed: boolean;
}

export interface ShootInput {
  readonly appUrl: AppUrl;
  readonly route: string;
  readonly viewport: ScreenViewport;
  readonly theme: ScreenTheme;
  readonly storageState: StorageState | null;
  /**
   * The daemon's address and the read-only dev UI token, handed to the page in its fragment and let
   * through to the daemon for reads, when the app is 10db's own dev UI; null for every other app.
   */
  readonly devUi: DevUiHandOff | null;
  readonly signal: AbortSignal;
}

export interface SignInInput {
  readonly appUrl: AppUrl;
  readonly url: string;
  readonly signal: AbortSignal;
}

export interface PageCamera {
  shoot(input: ShootInput): Promise<Shot>;
  /**
   * Opens `url` (same origin as `appUrl`) in a fresh context, under the same guard as a shot, and
   * answers its storage state; throws when it lands off the app's origin.
   */
  signIn(input: SignInInput): Promise<StorageState>;
  /** The browser's readiness, for Settings: fetching, ready, refused (with why), off. */
  status(): BrowserStatus;
  close(): Promise<void>;
}

/** A camera with no browser behind it: refused, saying why; it takes no picture and signs nothing in. */
export function refusedCamera(problem: string): PageCamera {
  return {
    shoot: (input) =>
      Promise.resolve({
        outcome: ShotOutcome.Failed,
        png: null,
        width: input.viewport.width,
        height: input.viewport.height,
        landedUrl: null,
        overlayText: null,
        reason: problem,
        cameraFailed: true,
      }),
    signIn: () => Promise.reject(new Error(problem)),
    status: () => ({ state: 'refused', problem }),
    close: () => Promise.resolve(),
  };
}
