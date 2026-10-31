import {
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeConfigPatch,
  JudgeDecision,
  JudgeStatusDto,
  mintId,
} from '@10db/contracts';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { baseHandlers, daemonUrl, server } from './daemon';

export function judgeStatusDto(overrides: Partial<JudgeStatusDto> = {}): JudgeStatusDto {
  return JudgeStatusDto.parse({
    config: DEFAULT_JUDGE_CONFIG,
    keySet: false,
    off: false,
    ...overrides,
  });
}

export function judgeCallDto(overrides: Partial<JudgeCallDto> = {}): JudgeCallDto {
  return JudgeCallDto.parse({
    id: mintId('JudgeCall'),
    decision: JudgeDecision.ReviewSize,
    model: 'typesafe/jev-1.13',
    question: 'Does this change need an independent code review?',
    answer: 'skip',
    confidence: 0.93,
    outcome: 'acted',
    latencyMs: 410,
    costUsd: 0.0001,
    workstreamId: null,
    taskId: null,
    createdAt: '2026-10-31T12:00:00.000Z',
    ...overrides,
  });
}

export interface JudgeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A judge that remembers what it was sent, serving status and calls from mutable state. */
export function serveJudge(initial: {
  readonly status?: JudgeStatusDto;
  readonly calls?: readonly JudgeCallDto[];
  readonly test?: JsonBodyType;
}) {
  let status = initial.status ?? judgeStatusDto();
  const sent: JudgeRequest[] = [];
  const note = async (request: Request) => {
    const text = await request.text();
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === '' ? null : JSON.parse(text),
    });
  };
  server.use(
    http.get(daemonUrl('/judge'), () => HttpResponse.json(status)),
    http.patch(daemonUrl('/judge'), async ({ request }) => {
      const body = JudgeConfigPatch.parse(await request.clone().json());
      await note(request);
      status = {
        ...status,
        config: {
          enabled: body.enabled ?? status.config.enabled,
          decisions: {
            review_size: {
              enabled:
                body.decisions?.review_size?.enabled ?? status.config.decisions.review_size.enabled,
              model:
                body.decisions?.review_size?.model ?? status.config.decisions.review_size.model,
              floor:
                body.decisions?.review_size?.floor ?? status.config.decisions.review_size.floor,
            },
          },
        },
      };
      return HttpResponse.json(status);
    }),
    http.put(daemonUrl('/judge/key'), async ({ request }) => {
      await note(request);
      status = { ...status, keySet: true };
      return HttpResponse.json(status);
    }),
    http.delete(daemonUrl('/judge/key'), async ({ request }) => {
      await note(request);
      status = { ...status, keySet: false };
      return HttpResponse.json(status);
    }),
    http.post(daemonUrl('/judge/test'), async ({ request }) => {
      await note(request);
      return HttpResponse.json(initial.test);
    }),
    http.get(daemonUrl('/judge/calls'), () => HttpResponse.json(initial.calls ?? [])),
    ...baseHandlers(),
  );
  return sent;
}
