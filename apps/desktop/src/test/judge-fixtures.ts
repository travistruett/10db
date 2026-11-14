import {
  DecisionModelDto,
  DecisionStatsDto,
  type DecisionStatsListDto,
  DEFAULT_JUDGE_CONFIG,
  type AccountDto,
  JudgeCallDto,
  JudgeCallsPageQuery,
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
    account: null,
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

/** A decision's last 30 days: no calls unless `overrides` says so. */
export function decisionStatsDto(
  decision: JudgeDecision,
  overrides: Partial<DecisionStatsDto> = {},
): DecisionStatsDto {
  return DecisionStatsDto.parse({
    decision,
    calls: 0,
    acted: 0,
    belowFloor: 0,
    shadow: 0,
    stopped: 0,
    fallbacks: { off: 0, no_key: 0, timeout: 0, error: 0 },
    costUsd: 0,
    medianLatencyMs: null,
    answers: [],
    ...overrides,
  });
}

export function decisionModelDto(overrides: Partial<DecisionModelDto> = {}): DecisionModelDto {
  return DecisionModelDto.parse({
    id: 'typesafe/jev-1.13',
    name: 'Jev 1.13',
    maker: 'TypeSafe',
    latest: false,
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    cantCall: null,
    ...overrides,
  });
}

export interface JudgeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** The request's search params, when it has any. */
  readonly query?: Readonly<Record<string, string>>;
}

/** A judge that remembers what it was sent, serving status and calls from mutable state. */
export function serveJudge(initial: {
  readonly status?: JudgeStatusDto;
  readonly calls?: readonly JudgeCallDto[];
  readonly test?: JsonBodyType;
  readonly measures?: ShapeMeasuresDto;
  /** `GET /judge/decisions`; the daemon leaves out a decision with no calls, so the default lists none. */
  readonly stats?: DecisionStatsListDto;
  /** The accounts a patch naming `accountId` can resolve to the status's account. */
  readonly accounts?: readonly AccountDto[];
  /** OpenRouter's decision models, as `GET /judge/models` answers them. */
  readonly models?: readonly DecisionModelDto[];
  /** Why the daemon refuses a patch that changes a model, as when the model fails its test decision. */
  readonly refuseModel?: string;
}) {
  let status = initial.status ?? judgeStatusDto();
  const sent: JudgeRequest[] = [];
  const note = async (request: Request) => {
    const text = await request.text();
    const params = new URL(request.url).searchParams;
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === '' ? null : JSON.parse(text),
      ...(params.size > 0 ? { query: Object.fromEntries(params) } : {}),
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
      const changesModel = Object.values(body.decisions ?? {}).some((d) => d?.model !== undefined);
      if (initial.refuseModel !== undefined && changesModel)
        return HttpResponse.json(
          { error: 'invalid', message: initial.refuseModel },
          { status: 400 },
        );
      const merged = (name: JudgeDecision) => {
        const current = status.config.decisions[name];
        const change = body.decisions?.[name];
        return {
          enabled: change?.enabled ?? current.enabled,
          model: change?.model ?? current.model,
          floor: change?.floor ?? current.floor,
        };
      };
      const accountId = body.accountId === undefined ? status.config.accountId : body.accountId;
      const named = initial.accounts?.find((a) => a.id === accountId);
      status = {
        ...status,
        account: named
          ? {
              id: named.id,
              label: named.label,
              secretSet: named.secretSet,
              secretState: named.secretSet ? 'set' : 'missing',
            }
          : null,
        config: {
          enabled: body.enabled ?? status.config.enabled,
          accountId,
          decisions: {
            review_size: merged(JudgeDecision.ReviewSize),
            shape_ready: merged(JudgeDecision.ShapeReady),
            shape_record: merged(JudgeDecision.ShapeRecord),
            shape_elsewhere: merged(JudgeDecision.ShapeElsewhere),
            question_route: merged(JudgeDecision.QuestionRoute),
            thread_answer: merged(JudgeDecision.ThreadAnswer),
            reply_match: merged(JudgeDecision.ReplyMatch),
            approval_read: merged(JudgeDecision.ApprovalRead),
            task_rigor: merged(JudgeDecision.TaskRigor),
            task_kinds: merged(JudgeDecision.TaskKinds),
          },
        },
      };
      return HttpResponse.json(status);
    }),
    http.post(daemonUrl('/accounts/:accountId/test'), async ({ request }) => {
      await note(request);
      return HttpResponse.json(initial.test);
    }),
    http.get(daemonUrl('/judge/calls'), () => HttpResponse.json(initial.calls ?? [])),
    http.get(daemonUrl('/judge/calls/page'), async ({ request }) => {
      await note(request);
      const query = JudgeCallsPageQuery.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const matching = [...(initial.calls ?? [])]
        .filter((c) => query.decision === undefined || c.decision === query.decision)
        .filter((c) => query.outcome === undefined || c.outcome === query.outcome)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return HttpResponse.json({
        calls: matching.slice(query.offset, query.offset + query.limit),
        total: matching.length,
      });
    }),
    http.get(daemonUrl('/judge/decisions'), () =>
      HttpResponse.json(initial.stats ?? { since: '2026-10-14T12:00:00.000Z', decisions: [] }),
    ),
    http.get(daemonUrl('/judge/models'), () =>
      HttpResponse.json({
        models: initial.models ?? [decisionModelDto()],
        fetchedAt: '2026-11-13T12:00:00.000Z',
      }),
    ),
    ...baseHandlers(),
  );
  return sent;
}
