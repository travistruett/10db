import { z } from 'zod';
import type { AppUrl } from './entities';
import { GitObjectName } from './git-names';
import { PassTurnId, TaskId, TaskScreenId } from './ids';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §11, §13: pictures of the
// builder's app, taken by the daemon's own browser before, during and after a task, kept by their hash
// on the Mac and never sent to a model.

const Timestamp = z.iso.datetime();

type ValueOf<T> = T[keyof T];

/** When a picture was taken: before the task's first edit, after a turn of a pass task, or once done. */
export const ScreenKind = { Before: 'before', Turn: 'turn', After: 'after' } as const;
export type ScreenKind = ValueOf<typeof ScreenKind>;

/** The color scheme the page is shown in; `default` emulates none, so the app's own default shows. */
export const ScreenTheme = { Default: 'default', Light: 'light', Dark: 'dark' } as const;
export type ScreenTheme = ValueOf<typeof ScreenTheme>;

/** One browser window size, in CSS pixels; a picture is the viewport at 1x, never the full page. */
export const ScreenViewport = z.object({
  width: z.int().min(320).max(3840),
  height: z.int().min(320).max(2400),
});
export type ScreenViewport = z.infer<typeof ScreenViewport>;

/** How many pictures one route takes per capture at most: viewports times themes. */
export const SCREENS_MATRIX_MAX_PICTURES = 4;

/** The viewports and themes each route is shot in. */
export const ScreensMatrix = z
  .object({
    viewports: z.array(ScreenViewport).min(1).max(3),
    themes: z.array(z.enum(ScreenTheme)).min(1).max(3),
  })
  .refine((m) => m.viewports.length * m.themes.length <= SCREENS_MATRIX_MAX_PICTURES, {
    message: `The screenshot matrix takes at most ${String(SCREENS_MATRIX_MAX_PICTURES)} pictures a route: fewer viewports or themes`,
    path: ['viewports'],
  })
  .refine(
    (m) =>
      new Set(m.viewports.map((v) => `${String(v.width)}x${String(v.height)}`)).size ===
      m.viewports.length,
    { message: 'A viewport is named twice', path: ['viewports'] },
  )
  .refine((m) => new Set(m.themes).size === m.themes.length, {
    message: 'A theme is named twice',
    path: ['themes'],
  });
export type ScreensMatrix = z.infer<typeof ScreensMatrix>;

/** One viewport, 1440 by 900, in the app's own default theme. */
export const SCREENS_MATRIX_DEFAULT: ScreensMatrix = {
  viewports: [{ width: 1440, height: 900 }],
  themes: [ScreenTheme.Default],
};

/**
 * A path on the app's address the browser may load: it starts with one `/`, may carry a query, and has
 * no fragment, backslash, space or control character, so it can never name another host.
 */
export const PageRoute = z
  .string()
  .max(512)
  .regex(
    /^\/(?!\/)[^#\\\s\p{Cc}]*$/u,
    'A route is a path on the app, such as /people or /people?tab=all',
  );
export type PageRoute = z.infer<typeof PageRoute>;

/** The address the browser loads for `route` on `appUrl`; null unless it is a route and stays on that origin. */
export function routeUrl(appUrl: AppUrl, route: string): string | null {
  if (!PageRoute.safeParse(route).success) return null;
  let url: URL;
  try {
    url = new URL(route, appUrl);
  } catch {
    return null;
  }
  return url.origin === appUrl ? url.href : null;
}

/** A picture of the app. Where the daemon keeps its file stays with the daemon; the UI reads it by id. */
export const TaskScreenDto = z.object({
  id: TaskScreenId,
  taskId: TaskId,
  /** The pass turn it was taken after; null for a before, an after, or a task outside a pass. */
  turnId: PassTurnId.nullable(),
  turnSeq: z.int().min(1).nullable(),
  kind: z.enum(ScreenKind),
  route: PageRoute,
  viewport: ScreenViewport,
  theme: z.enum(ScreenTheme),
  /** The PNG's own size in pixels, read from its header. */
  width: z.int().min(1),
  height: z.int().min(1),
  size: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The kept commit (a pass turn's) or the folder's HEAD the picture was taken at. */
  keptSha: GitObjectName.nullable(),
  createdAt: Timestamp,
});
export type TaskScreenDto = z.infer<typeof TaskScreenDto>;

/** A task's pictures, oldest first, and the pictures of the goal it came from (empty until a goal has them). */
export const TaskScreensDto = z.object({
  taskId: TaskId,
  screens: z.array(TaskScreenDto),
  fromGoal: z.array(TaskScreenDto),
});
export type TaskScreensDto = z.infer<typeof TaskScreensDto>;

/** Whether the browser for pictures can be used: off until needed, fetching its pinned build, ready, or refused. */
export const BrowserState = {
  Off: 'off',
  Fetching: 'fetching',
  Ready: 'ready',
  Refused: 'refused',
} as const;
export type BrowserState = ValueOf<typeof BrowserState>;

/** What Settings says about a project's pictures: the browser, and the last sign-in's problem. */
export const PicturesStatusDto = z.object({
  browser: z.object({ state: z.enum(BrowserState), problem: z.string().nullable() }),
  /** The last dev login 10db ran for the project; null when none ran since the daemon started. */
  signIn: z.object({ problem: z.string().nullable(), at: Timestamp }).nullable(),
});
export type PicturesStatusDto = z.infer<typeof PicturesStatusDto>;

/** `task.screen_added`: a picture of the task was kept. */
export const TaskScreenAddedData = z.object({
  taskId: TaskId,
  screenId: TaskScreenId,
  turnId: PassTurnId.nullable(),
  kind: z.enum(ScreenKind),
});
export type TaskScreenAddedData = z.infer<typeof TaskScreenAddedData>;
