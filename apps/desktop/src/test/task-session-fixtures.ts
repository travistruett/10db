import { mintId, TaskSessionDto } from '@10db/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { daemonUrl } from './daemon';

// A task's session as `GET /tasks/:taskId/session` answers it. Every DTO is parsed with its contract.

export function taskSessionDto(overrides: Partial<TaskSessionDto> = {}): TaskSessionDto {
  return TaskSessionDto.parse({
    taskId: mintId('Task'),
    title: 'Retry login once on a 401',
    place: 'copy',
    branch: '10db/retry-401',
    board: 'in_progress',
    conversationId: mintId('Conversation'),
    fromChat: null,
    passId: null,
    workstreamId: null,
    pullRequest: null,
    ...overrides,
  });
}

/** The session route over the sessions given; a task it doesn't know answers 404. */
export function taskSessionHandlers(
  sessions: readonly TaskSessionDto[] | (() => readonly TaskSessionDto[]),
): HttpHandler[] {
  return [
    http.get(daemonUrl('/tasks/:taskId/session'), ({ params }) => {
      const list = typeof sessions === 'function' ? sessions() : sessions;
      const found = list.find((s) => s.taskId === params['taskId']);
      return found === undefined
        ? HttpResponse.json({ error: 'not_found', message: 'No such task.' }, { status: 404 })
        : HttpResponse.json(found);
    }),
  ];
}
