import type { AaModelDto } from '@10db/contracts';
import { z } from 'zod';

/** AA's free model list; every request carries the builder's own key, never a shared one. */
export const AA_FREE_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';

/** Pages fetched in one sync at most, so a bad response can't burn the daily quota. */
const MAX_PAGES = 10;

const Numbers = z
  .record(z.string(), z.unknown())
  .transform((rec) =>
    Object.fromEntries(
      Object.entries(rec).filter(
        (e): e is [string, number | null] => typeof e[1] === 'number' || e[1] === null,
      ),
    ),
  );

/** Only the fields 10db uses; everything else AA sends is ignored. */
const AaEntry = z.looseObject({
  slug: z.string().min(1),
  name: z.string(),
  release_date: z.string().nullable().optional(),
  model_creator: z.looseObject({ name: z.string() }),
  evaluations: Numbers.optional(),
  artificial_analysis_intelligence_index_cost: z
    .looseObject({
      cost_per_task: z.looseObject({ total_cost: z.number().nullable() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  pricing: Numbers.optional(),
  performance: Numbers.optional(),
});

const AaPage = z.looseObject({
  intelligence_index_version: z.union([z.string(), z.number()]).nullable().optional(),
  pagination: z.looseObject({ has_more: z.boolean() }),
  data: z.array(AaEntry),
});

export type AaFetchOutcome =
  | { readonly kind: 'ok'; readonly models: AaModelDto[] }
  | { readonly kind: 'unauthorized' | 'rate_limited' | 'failed'; readonly message: string };

function toModel(entry: z.infer<typeof AaEntry>, version: string | null, now: string): AaModelDto {
  return {
    slug: entry.slug,
    name: entry.name,
    creator: entry.model_creator.name,
    releaseDate: entry.release_date ?? null,
    indexVersion: version,
    evaluations: entry.evaluations ?? {},
    costPerTaskUsd:
      entry.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null,
    pricing: entry.pricing ?? {},
    performance: entry.performance ?? {},
    fetchedAt: now,
  };
}

/** Fetches every page; any failure returns an outcome, never throws, and never repeats the key. */
export async function fetchAaModels(deps: {
  readonly fetch: typeof fetch;
  readonly key: string;
  readonly now: string;
}): Promise<AaFetchOutcome> {
  const models: AaModelDto[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let res: Response;
    try {
      res = await deps.fetch(`${AA_FREE_MODELS_URL}?page=${String(page)}`, {
        headers: { 'x-api-key': deps.key, accept: 'application/json' },
      });
    } catch (error) {
      return {
        kind: 'failed',
        message: `Artificial Analysis could not be reached (${error instanceof Error ? error.name : 'error'})`,
      };
    }
    if (res.status === 401 || res.status === 403)
      return { kind: 'unauthorized', message: 'Artificial Analysis refused the key' };
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After');
      return {
        kind: 'rate_limited',
        message: `The daily Artificial Analysis limit is used up${retry ? `; retry in ${retry} s` : ''}`,
      };
    }
    if (!res.ok)
      return { kind: 'failed', message: `Artificial Analysis answered ${String(res.status)}` };
    const parsed = AaPage.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      return {
        kind: 'failed',
        message: 'Artificial Analysis sent a response 10db does not understand',
      };
    const raw = parsed.data.intelligence_index_version;
    const version = raw === null || raw === undefined ? null : String(raw);
    models.push(...parsed.data.data.map((entry) => toModel(entry, version, deps.now)));
    if (!parsed.data.pagination.has_more) return { kind: 'ok', models };
  }
  return { kind: 'ok', models };
}
