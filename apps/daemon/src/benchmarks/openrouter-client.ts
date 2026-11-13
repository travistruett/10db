import { z } from 'zod';

/** OpenRouter's benchmark scores; 30 requests a minute per key, 500 a day per account. */
export const OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks';
/** OpenRouter's model list; it needs no key. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Where one model's per-provider stats are read; they need a key. */
export const endpointsUrl = (id: string): string =>
  `${OPENROUTER_MODELS_URL}/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`;

/** One score row: an Artificial Analysis index set, or one OpenRouter benchmark's accuracy and cost. */
export interface OpenRouterScoreRow {
  /** OpenRouter's permaslug with its trailing `-YYYYMMDD` dropped. */
  readonly id: string;
  readonly source: 'aa' | 'openrouter';
  readonly intelligence: number | null;
  readonly coding: number | null;
  readonly agentic: number | null;
  readonly benchmark: string | null;
  readonly accuracy: number | null;
  readonly costPerTaskUsd: number | null;
}

/** One provider's p50 speed and latency for a model. */
export interface EndpointStat {
  readonly provider: string;
  readonly tokensPerSecond: number | null;
  readonly latencyMs: number | null;
}

export type OpenRouterOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' | 'rate_limited' | 'failed'; readonly message: string };

const DATE_SUFFIX = /-\d{8}$/;
const MESSAGE_BODY_CHARS = 200;

const Envelope = z.looseObject({ data: z.array(z.unknown()) });
const nullableNumber = z.number().nullable().optional();

const AaItem = z.looseObject({
  model_permaslug: z.string().min(1),
  intelligence_index: nullableNumber,
  coding_index: nullableNumber,
  agentic_index: nullableNumber,
});

const OpenRouterItem = z.looseObject({
  model_permaslug: z.string().min(1),
  benchmark_type: z.string().nullable().optional(),
  accuracy: nullableNumber,
  avg_cost_per_task: nullableNumber,
});

const Percentiles = z.looseObject({ p50: nullableNumber }).nullable().optional();
const EndpointItem = z.looseObject({
  provider_name: z.string().min(1),
  throughput_last_30m: Percentiles,
  latency_last_30m: Percentiles,
});
const EndpointsBody = z.looseObject({
  data: z.looseObject({ endpoints: z.array(z.unknown()) }),
});

const ModelIdItem = z.looseObject({ id: z.string().min(1) });

interface Request {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal | undefined;
}

const failed = (message: string): { kind: 'failed'; message: string } => ({
  kind: 'failed',
  message,
});

/** Reads one URL as JSON; the key never reaches a message. */
async function getJson(
  url: string,
  deps: Request & { readonly key?: string | undefined },
): Promise<OpenRouterOutcome<unknown>> {
  const scrub = (text: string): string =>
    deps.key === undefined || deps.key === '' ? text : text.split(deps.key).join('[key]');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (deps.key !== undefined) headers['authorization'] = `Bearer ${deps.key}`;
  let res: Response;
  try {
    res = await deps.fetch(url, { headers, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    return failed(
      scrub(`OpenRouter could not be reached (${error instanceof Error ? error.name : 'error'})`),
    );
  }
  if (res.status === 401 || res.status === 403)
    return { kind: 'unauthorized', message: 'OpenRouter refused the key' };
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    return {
      kind: 'rate_limited',
      message: `OpenRouter's rate limit is used up${retry ? `; retry in ${scrub(retry)} s` : ''}`,
    };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const body = scrub(text).slice(0, MESSAGE_BODY_CHARS).trim();
    return failed(`OpenRouter answered ${String(res.status)}${body ? `: ${body}` : ''}`);
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown }; // validated by the caller's schema
  } catch {
    return failed('OpenRouter sent a response 10db does not understand');
  }
}

const NOT_UNDERSTOOD = 'OpenRouter sent a response 10db does not understand';

/** The items of an enveloped list, each parsed alone so one bad item hides nothing else. */
function items<T>(body: unknown, item: z.ZodType<T>): T[] | null {
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) return null;
  const out: T[] = [];
  for (const raw of envelope.data.data) {
    const parsed = item.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Both benchmark sources, Artificial Analysis's first; either failing is the whole outcome. */
export async function fetchOpenRouterScores(
  deps: Request & { readonly key: string },
): Promise<OpenRouterOutcome<OpenRouterScoreRow[]>> {
  const rows: OpenRouterScoreRow[] = [];
  const aa = await getJson(`${OPENROUTER_BENCHMARKS_URL}?source=artificial-analysis`, deps);
  if (aa.kind !== 'ok') return aa;
  const aaItems = items(aa.value, AaItem);
  if (aaItems === null) return failed(NOT_UNDERSTOOD);
  for (const item of aaItems)
    rows.push({
      id: item.model_permaslug.replace(DATE_SUFFIX, ''),
      source: 'aa',
      intelligence: item.intelligence_index ?? null,
      coding: item.coding_index ?? null,
      agentic: item.agentic_index ?? null,
      benchmark: null,
      accuracy: null,
      costPerTaskUsd: null,
    });
  const own = await getJson(`${OPENROUTER_BENCHMARKS_URL}?source=openrouter`, deps);
  if (own.kind !== 'ok') return own;
  const ownItems = items(own.value, OpenRouterItem);
  if (ownItems === null) return failed(NOT_UNDERSTOOD);
  for (const item of ownItems)
    rows.push({
      id: item.model_permaslug.replace(DATE_SUFFIX, ''),
      source: 'openrouter',
      intelligence: null,
      coding: null,
      agentic: null,
      benchmark: item.benchmark_type ?? null,
      accuracy: item.accuracy ?? null,
      costPerTaskUsd: item.avg_cost_per_task ?? null,
    });
  return { kind: 'ok', value: rows };
}

/** Every model id OpenRouter lists. The list is public, so no key is sent. */
export async function fetchOpenRouterModelIds(deps: Request): Promise<OpenRouterOutcome<string[]>> {
  const res = await getJson(OPENROUTER_MODELS_URL, deps);
  if (res.kind !== 'ok') return res;
  const found = items(res.value, ModelIdItem);
  if (found === null) return failed(NOT_UNDERSTOOD);
  return { kind: 'ok', value: found.map((m) => m.id) };
}

/** One model's p50 throughput and latency per provider; a provider with no stats reads null, never zero. */
export async function fetchEndpointStats(
  deps: Request & { readonly key: string; readonly id: string },
): Promise<OpenRouterOutcome<EndpointStat[]>> {
  const res = await getJson(endpointsUrl(deps.id), deps);
  if (res.kind !== 'ok') return res;
  const body = EndpointsBody.safeParse(res.value);
  if (!body.success) return failed(NOT_UNDERSTOOD);
  const stats: EndpointStat[] = [];
  for (const raw of body.data.data.endpoints) {
    const parsed = EndpointItem.safeParse(raw);
    if (!parsed.success) continue;
    stats.push({
      provider: parsed.data.provider_name,
      tokensPerSecond: parsed.data.throughput_last_30m?.p50 ?? null,
      latencyMs: parsed.data.latency_last_30m?.p50 ?? null,
    });
  }
  return { kind: 'ok', value: stats };
}
