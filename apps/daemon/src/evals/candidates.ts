import { EvalModelId, type EvalCandidateDto, type EvalLiveModels } from '@10db/contracts';
import { joinOpenRouterId, type Catalogue } from '../catalogue';
import { estimateRunCost } from './sweep-cost';
import type { ParsedRun } from './run-summary';

/** The catalogue's OpenRouter entries are the models a suite can name; a row of the Models page names its figures. */
export interface CandidateInput {
  readonly models: EvalLiveModels;
  readonly catalogue: Catalogue | null;
  /** Intelligence by catalogue model id, from the Models page's rows. */
  readonly intelligence: ReadonlyMap<string, number | null>;
  /** The suite's runs, oldest first. */
  readonly runs: readonly ParsedRun[];
}

interface Option {
  /** What a sweep picks: an OpenRouter id, or a choice's name. */
  readonly pick: string;
  /** What a result may call it: the pick, and a choice's model. */
  readonly aliases: readonly string[];
  readonly openRouterId: string;
}

interface Verdict {
  readonly passed: boolean;
  readonly costUsd: number | null;
  readonly at: string;
}

/** One run's verdict on a model: it passed only if every slot did; its cost is unknown if any slot's is. */
function verdictIn(run: ParsedRun, aliases: readonly string[]): Verdict | null {
  const results = run.models.filter((m) => aliases.includes(m.model));
  if (results.length === 0) return null;
  return {
    passed: results.every((r) => r.passed),
    costUsd: results.some((r) => r.costUsd === null)
      ? null
      : results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    at: run.at,
  };
}

/**
 * What a suite may try, each with the maker's output price, intelligence, an estimate of one run's cost and its
 * last result here. An `openrouter` suite takes every current OpenRouter catalogue model (an enabled profile
 * reaches OpenRouter through the same entry); a `choices` suite takes only its choices. The estimate scales the
 * newest run's cheapest passing model that has a cost (else its first with a cost) by output price.
 */
export function buildCandidates(input: CandidateInput): EvalCandidateDto[] {
  const listed = (input.catalogue?.providers['openrouter']?.models ?? []).filter(
    (m) => !m.deprecated,
  );
  const entry = new Map(listed.map((m) => [m.id, m]));
  const options: Option[] =
    input.models.ids === 'openrouter'
      ? listed
          .filter((m) => EvalModelId.safeParse(m.id).success)
          .map((m) => ({ pick: m.id, aliases: [m.id], openRouterId: m.id }))
      : input.models.ids.choices.map((c) => ({
          pick: c.name,
          aliases: [...new Set([c.name, c.model])],
          openRouterId: c.model,
        }));
  const priceOf = (openRouterId: string): number | null =>
    entry.get(openRouterId)?.outputPrice ?? null;

  const reference = referenceOf(input.runs.at(-1), options, priceOf);
  const candidates = options.map((option): EvalCandidateDto => {
    const outputPrice = priceOf(option.openRouterId);
    const modelId =
      input.catalogue === null ? null : joinOpenRouterId(option.openRouterId, input.catalogue);
    let last: Verdict | null = null;
    for (const run of [...input.runs].reverse()) {
      last = verdictIn(run, option.aliases);
      if (last !== null) break;
    }
    return {
      model: option.pick,
      name: entry.get(option.openRouterId)?.name ?? null,
      intelligence: modelId === null ? null : (input.intelligence.get(modelId) ?? null),
      outputPrice,
      estimateUsd: estimateRunCost(reference, outputPrice),
      last,
    };
  });
  // Cheapest first (unpriced last), so the list reads in the order a cheapest sweep would run.
  return candidates.sort(
    (a, b) =>
      (a.outputPrice ?? Infinity) - (b.outputPrice ?? Infinity) || a.model.localeCompare(b.model),
  );
}

/** The run's models in the order it lists them, each as `verdictIn` reads it, with the maker's price. */
function referenceOf(
  run: ParsedRun | undefined,
  options: readonly Option[],
  priceOf: (openRouterId: string) => number | null,
): { costUsd: number; outputPrice: number } | null {
  if (run === undefined) return null;
  const costed = [...new Set(run.models.map((m) => m.model))].flatMap((model) => {
    const verdict = verdictIn(run, [model]);
    const option = options.find((o) => o.aliases.includes(model));
    const outputPrice = priceOf(option?.openRouterId ?? model);
    return verdict?.costUsd == null || outputPrice === null
      ? []
      : [{ passed: verdict.passed, costUsd: verdict.costUsd, outputPrice }];
  });
  const cheapestPass = costed.filter((c) => c.passed).sort((a, b) => a.costUsd - b.costUsd)[0];
  const chosen = cheapestPass ?? costed[0];
  return chosen === undefined ? null : { costUsd: chosen.costUsd, outputPrice: chosen.outputPrice };
}
