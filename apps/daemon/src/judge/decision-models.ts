import type { DecisionModelDto } from '@10db/contracts';
import { z } from 'zod';
import { DECISIONS_PATH, OpenRouterError } from './openrouter';

/**
 * OpenRouter's decision models. The unfiltered `/models` list leaves them out: they are listed only when asked for
 * by their output modality. No key is needed.
 */
export const DECISION_MODELS_URL =
  'https://openrouter.ai/api/v1/models?output_modalities=decisions';

const PER_MILLION = 1_000_000;
/** Per-token prices times a million carry float noise ("0.020000000000000004"); twelve digits drop it. */
const perMillion = (perToken: number): number => Number((perToken * PER_MILLION).toPrecision(12));

const Price = z.string().min(1).transform(Number).pipe(z.number().nonnegative());

/** One entry of the list, read on its own so one 10db can't read never hides the rest. */
const ModelEntry = z.object({
  id: z.string().min(1),
  name: z.string(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({ prompt: Price, completion: Price }),
  /** The paths OpenRouter serves the model on. */
  endpoints: z.array(z.string()).optional(),
});

const ModelList = z.object({ data: z.array(z.unknown()) });

function cantCall(entry: z.infer<typeof ModelEntry>): string | null {
  if (entry.endpoints !== undefined && !entry.endpoints.includes(DECISIONS_PATH))
    return "10db can't call this model yet: OpenRouter serves it for extractions, not decisions.";
  if (!entry.architecture.input_modalities.includes('text'))
    return "10db can't call this model yet: it reads no text.";
  return null;
}

/** "TypeSafe: Jev 1.13" is made by TypeSafe; a name with no maker takes it from the id. */
function makerAndName(entry: z.infer<typeof ModelEntry>): { maker: string; name: string } {
  const colon = entry.name.indexOf(': ');
  if (colon > 0) return { maker: entry.name.slice(0, colon), name: entry.name.slice(colon + 2) };
  const maker = entry.id.replace(/^~/, '').split('/')[0] ?? entry.id;
  return { maker, name: entry.name };
}

const byMakerLatestName = (a: DecisionModelDto, b: DecisionModelDto): number =>
  a.maker.localeCompare(b.maker) ||
  Number(b.latest) - Number(a.latest) ||
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** OpenRouter's `/models` answer, kept to its decision models, in the order Settings lists them. */
export function decisionModelsFrom(body: unknown): DecisionModelDto[] {
  const list = ModelList.safeParse(body);
  if (!list.success) throw new OpenRouterError("OpenRouter's model list could not be read");
  const models: DecisionModelDto[] = [];
  for (const raw of list.data.data) {
    const parsed = ModelEntry.safeParse(raw);
    if (!parsed.success || !parsed.data.architecture.output_modalities.includes('decisions'))
      continue;
    const entry = parsed.data;
    models.push({
      id: entry.id,
      ...makerAndName(entry),
      latest: entry.id.startsWith('~'),
      inputUsdPerMillion: perMillion(entry.pricing.prompt),
      outputUsdPerMillion: perMillion(entry.pricing.completion),
      cantCall: cantCall(entry),
      costPerMillionUsd: null,
      secondsPerDecision: null,
      costSource: null,
      timeSource: null,
    });
  }
  return models.sort(byMakerLatestName);
}
