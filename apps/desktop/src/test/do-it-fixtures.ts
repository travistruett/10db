import {
  DoItBriefDto,
  DoItPreviewDto,
  DoItRequest,
  DoItResult,
  mintId,
  type BriefRequest,
  type TaskId,
} from '@10db/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { daemonUrl } from './daemon';

// Do It as the daemon serves it: the sheet's preview, the brief's ask and cancel, and the hand-off. Every
// DTO is parsed with its contract.

const OFFERED = { offered: true, refusal: null, whenBusy: false } as const;

export function doItBriefDto(overrides: Partial<DoItBriefDto> = {}): DoItBriefDto {
  return DoItBriefDto.parse({
    title: 'Retry login once on a 401',
    text: 'When the laptop wakes, the first API call returns 401. Retry once after a refresh.',
    areas: [],
    criteria: [],
    source: 'agent',
    reason: null,
    writing: false,
    ...overrides,
  });
}

/** The sheet's preview of a project on pull requests with nothing uncommitted, until a test says otherwise. */
export function doItPreviewDto(overrides: Partial<DoItPreviewDto> = {}): DoItPreviewDto {
  return DoItPreviewDto.parse({
    brief: doItBriefDto(),
    changed: [],
    more: 0,
    worktree: OFFERED,
    here: OFFERED,
    runningTurn: false,
    stacksOn: null,
    base: 'main',
    leftOut: null,
    ...overrides,
  });
}

export interface DoItServerOptions {
  /** What `GET /chats/:id/do-it` answers; a function reads the current answer on every request. */
  readonly preview: DoItPreviewDto | (() => DoItPreviewDto);
  /** `POST /chats/:id/do-it` answers 409 with these words instead of handing off. */
  readonly refusal?: string;
  /** What a hand-off answers; a task in the place asked for by default. */
  readonly result?: DoItResult;
  /** Runs when the hand-off is accepted, so a test can seal the chat in the server it stands in for. */
  readonly onDoIt?: (request: DoItRequest, taskId: TaskId) => void;
}

export interface DoItServer {
  readonly handlers: HttpHandler[];
  readonly requests: DoItRequest[];
  readonly briefAsks: BriefRequest[];
  readonly briefCancels: string[];
  readonly taskId: TaskId;
}

/** The routes of the Do It sheet over one preview. */
export function doItServer(opts: DoItServerOptions): DoItServer {
  const taskId = mintId('Task');
  const server: DoItServer = {
    handlers: [],
    requests: [],
    briefAsks: [],
    briefCancels: [],
    taskId,
  };
  const current = (): DoItPreviewDto =>
    typeof opts.preview === 'function' ? opts.preview() : opts.preview;
  server.handlers.push(
    http.get(daemonUrl('/chats/:chatId/do-it'), () => HttpResponse.json(current())),
    http.post(daemonUrl('/chats/:chatId/brief'), async ({ request }) => {
      server.briefAsks.push((await request.json()) as BriefRequest);
      return HttpResponse.json(current().brief);
    }),
    http.delete(daemonUrl('/chats/:chatId/brief'), ({ params }) => {
      server.briefCancels.push(String(params['chatId']));
      return HttpResponse.json(current().brief);
    }),
    http.post(daemonUrl('/chats/:chatId/do-it'), async ({ request }) => {
      const body = DoItRequest.parse(await request.json());
      server.requests.push(body);
      opts.onDoIt?.(body, taskId);
      if (opts.refusal !== undefined)
        return HttpResponse.json({ error: 'conflict', message: opts.refusal }, { status: 409 });
      return HttpResponse.json(DoItResult.parse(opts.result ?? { taskId, place: body.place }), {
        status: 201,
      });
    }),
  );
  return server;
}
