import { ProjectId, ScreenName, ShapeId, TaskId, type ScreenRenderRequest } from '@10db/contracts';
import { z } from 'zod';

// Shape spec §5.5. The app draws one of its screens in a hidden frame of itself, for a session's
// `see_screen`. What the frame is told is in its URL.

export interface RenderParams {
  /** The render token: it reads what a screen shows and nothing else. */
  readonly token: string;
  readonly daemon: string;
  readonly projectId: ProjectId;
  readonly screen: ScreenName;
  /** Where the frame's router opens. */
  readonly path: string;
}

/** The daemon listens on loopback only, and the window's CSP lets a frame reach nothing else. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

function pathOf(screen: ScreenName, shapeId: ShapeId | null, taskId: TaskId | null): string | null {
  switch (screen) {
    case ScreenName.Factory:
      return '/factory';
    case ScreenName.Board:
      return '/board';
    case ScreenName.Inbox:
      return '/inbox';
    case ScreenName.Plan:
      return shapeId === null ? null : `/shape/${shapeId}`;
    case ScreenName.Task:
      return taskId === null ? null : `/board?task=${taskId}`;
  }
}

/** The frame's address: the app itself, told what to draw. */
export function frameUrl(origin: string, request: ScreenRenderRequest, daemon: string): string {
  const params = new URLSearchParams({
    render: request.token,
    daemon,
    project: request.projectId,
    screen: request.screen,
    shape: request.shapeId,
    ...(request.taskId === undefined ? {} : { task: request.taskId }),
  });
  return `${origin}/?${params.toString()}`;
}

/** What a render frame was told, or null when the page is not one or what it was told is not believable. */
export function parseRenderParams(search: string): RenderParams | null {
  const params = new URLSearchParams(search);
  const token = params.get('render');
  const daemon = params.get('daemon');
  const project = ProjectId.safeParse(params.get('project'));
  const screen = z.enum(ScreenName).safeParse(params.get('screen'));
  if (token === null || token === '' || daemon === null || !LOOPBACK.test(daemon)) return null;
  if (!project.success || !screen.success) return null;
  const shape = params.has('shape') ? ShapeId.safeParse(params.get('shape')) : null;
  const task = params.has('task') ? TaskId.safeParse(params.get('task')) : null;
  if (shape !== null && !shape.success) return null;
  if (task !== null && !task.success) return null;
  const path = pathOf(screen.data, shape?.data ?? null, task?.data ?? null);
  return path === null
    ? null
    : { token, daemon, projectId: project.data, screen: screen.data, path };
}
