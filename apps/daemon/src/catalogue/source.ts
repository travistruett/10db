import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The one place models.dev publishes its catalogue. */
export const CATALOGUE_URL = 'https://models.dev/api.json';

/** The providers 10db reaches; the rest of models.dev's 235 are dropped at the boundary. */
export const CATALOGUE_PROVIDERS = ['anthropic', 'openai', 'amazon-bedrock', 'openrouter'] as const;

/** The catalogue is wrong as a whole, as opposed to one entry in it. */
export class CatalogueError extends Error {
  override readonly name = 'CatalogueError';
}

/** What 10db keeps of one models.dev entry. Prices are US dollars per million tokens. */
export const CatalogueModel = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * The lab that made the model, read from the provider and ID because models.dev has no such field;
   * null when the ID names no provider of the catalogue.
   */
  maker: z.string().min(1).nullable(),
  family: z.string().min(1).nullable(),
  releaseDate: z.string().min(1).nullable(),
  deprecated: z.boolean(),
  inputPrice: z.number().min(0).nullable(),
  outputPrice: z.number().min(0).nullable(),
});
export type CatalogueModel = z.infer<typeof CatalogueModel>;

export const CatalogueProvider = z.object({ models: z.array(CatalogueModel) });
export type CatalogueProvider = z.infer<typeof CatalogueProvider>;

export const Catalogue = z.object({
  providers: z.record(z.string(), CatalogueProvider),
  /** Covers IDs, prices, statuses and families only, so a change to anything else is not a change. */
  hash: z.string().min(1),
  /** Entries models.dev listed that failed validation and were left out. */
  skipped: z.int().min(0),
});
export type Catalogue = z.infer<typeof Catalogue>;

// Extra keys (cache prices, tiers, modes) are ignored; an entry may have no cost or no family.
const RawModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  family: z.string().min(1).optional(),
  release_date: z.unknown().optional(),
  status: z.string().optional(),
  cost: z
    .object({ input: z.number().min(0).optional(), output: z.number().min(0).optional() })
    .optional(),
});
const RawProvider = z.object({ models: z.record(z.string(), z.unknown()) });

const RELEASE_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

/** A release date as YYYY-MM-DD or YYYY-MM; anything else is no date. */
const releaseDateOf = (value: unknown): string | null =>
  typeof value === 'string' && RELEASE_DATE.test(value) ? value : null;

/**
 * The lab behind a model: the provider that lists it when that provider is the lab, else the first dot
 * segment of a Bedrock ID, or the segment before the slash of an OpenRouter ID, that names a provider
 * of the catalogue. Null when none does.
 */
function makerOf(provider: string, id: string, labs: ReadonlySet<string>): string | null {
  if (provider === 'openrouter') {
    const vendor = id.includes('/') ? id.split('/')[0] : undefined;
    return vendor === undefined || vendor === '' ? null : vendor;
  }
  if (provider === 'amazon-bedrock') return id.split('.').find((part) => labs.has(part)) ?? null;
  return provider;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function hashOf(providers: Record<string, CatalogueProvider>): string {
  const rows = Object.entries(providers)
    .sort(([a], [b]) => compare(a, b))
    .flatMap(([provider, { models }]) =>
      models
        .map((m) => [
          provider,
          m.id,
          m.family,
          m.releaseDate,
          m.deprecated,
          m.inputPrice,
          m.outputPrice,
        ])
        .sort((a, b) => compare(String(a[1]), String(b[1]))),
    );
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Reads models.dev's document, keeping only the providers 10db reaches. An entry that fails validation is
 * skipped and counted. A document that is not an object, or lacks any of those providers or has no valid
 * entry for one of them, is rejected whole, so a changed upstream shape can't replace a good catalogue.
 */
export function parseCatalogue(raw: unknown): Catalogue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new CatalogueError('the catalogue is not an object');
  const document: Record<string, unknown> = { ...raw };
  const labs = new Set(Object.keys(document));
  const providers: Record<string, CatalogueProvider> = {};
  let skipped = 0;
  for (const provider of CATALOGUE_PROVIDERS) {
    if (!(provider in document)) throw new CatalogueError(`the ${provider} provider is missing`);
    const parsed = RawProvider.safeParse(document[provider]);
    if (!parsed.success) throw new CatalogueError(`the ${provider} provider has no model list`);
    const models: CatalogueModel[] = [];
    for (const entry of Object.values(parsed.data.models)) {
      const m = RawModel.safeParse(entry);
      if (!m.success) {
        skipped += 1;
        continue;
      }
      models.push({
        provider,
        id: m.data.id,
        name: m.data.name,
        maker: makerOf(provider, m.data.id, labs),
        family: m.data.family ?? null,
        releaseDate: releaseDateOf(m.data.release_date),
        deprecated: m.data.status === 'deprecated',
        inputPrice: m.data.cost?.input ?? null,
        outputPrice: m.data.cost?.output ?? null,
      });
    }
    if (models.length === 0)
      throw new CatalogueError(`the ${provider} provider has no valid model`);
    providers[provider] = { models };
  }
  return { providers, hash: hashOf(providers), skipped };
}
