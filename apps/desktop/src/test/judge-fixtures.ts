import {
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeConfigPatch,
  JudgeDecision,
  JudgeStatusDto,
  mintId,
  SHAPE_JUDGE_DECISIONS,
  ShapeMeasuresDto,
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

/** Nothing measured yet: no finished converted task and no shadow answer. */
export function shapeMeasuresDto(overrides: Partial<ShapeMeasuresDto> = {}): ShapeMeasuresDto {
  const none = { n: 0, within: 0 };
  return ShapeMeasuresDto.parse({
    sizing: { ...none, buckets: { S: none, M: none, L: none, XL: none }, overrides: 0 },
    questions: { converted: { tasks: 0, cards: 0 }, other: { tasks: 0, cards: 0 } },
    shadow: SHAPE_JUDGE_DECISIONS.map((decision) => ({
      decision,
      answered: 0,
      scored: 0,
      agreed: 0,
      canShow: false,
    })),
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
  readonly measures?: ShapeMeasuresDto;
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
    http.get(daemonUrl('/shape-measures'), () =>
      HttpResponse.json(initial.measures ?? shapeMeasuresDto()),
    ),
    http.get(daemonUrl('/judge'), () => HttpResponse.json(status)),
    http.patch(daemonUrl('/judge'), async ({ request }) => {
      const body = JudgeConfigPatch.parse(await request.clone().json());
      await note(request);
      const merged = (name: JudgeDecision) => {
        const current = status.config.decisions[name];
        const change = body.decisions?.[name];
        return {
          enabled: change?.enabled ?? current.enabled,
          model: change?.model ?? current.model,
          floor: change?.floor ?? current.floor,
        };
      };
      status = {
        ...status,
        config: {
          enabled: body.enabled ?? status.config.enabled,
          decisions: {
            review_size: merged(JudgeDecision.ReviewSize),
            shape_ready: merged(JudgeDecision.ShapeReady),
            shape_record: merged(JudgeDecision.ShapeRecord),
            shape_elsewhere: merged(JudgeDecision.ShapeElsewhere),
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
