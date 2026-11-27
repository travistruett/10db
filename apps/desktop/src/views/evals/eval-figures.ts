import type { EvalGateDto, EvalModelResultDto } from '@10db/contracts';

/** A cost as the view says it: a report with none says "unknown", never $0. */
export function costText(usd: number | null): string {
  if (usd === null) return 'unknown';
  if (usd === 0) return '$0';
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toPrecision(2)}`;
}

/** The costs of a run's models, side by side, in the order the run lists them. */
export function modelCostsText(models: readonly EvalModelResultDto[]): string {
  return models.length === 0 ? '—' : models.map((m) => costText(m.costUsd)).join(' · ');
}

export function latencyText(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toPrecision(2)} s`;
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export const dayText = (iso: string): string => DAY.format(new Date(iso));
export const dayTimeText = (iso: string): string => DAY_TIME.format(new Date(iso));

/** The gate furthest under its minimum, which says why a model failed; null when every gate passed. */
export function worstGate(model: EvalModelResultDto): EvalGateDto | null {
  let worst: EvalGateDto | null = null;
  for (const gate of model.gates) {
    if (gate.passed) continue;
    // A gate with no stated minimum failed by the report's own word; it ranks below one that missed a number.
    const short = gate.minimum === null ? 0 : gate.minimum - gate.rate;
    const worstShort = worst?.minimum == null ? 0 : worst.minimum - worst.rate;
    if (worst === null || short > worstShort) worst = gate;
  }
  return worst;
}

export function gatesPassed(model: EvalModelResultDto): string {
  const passed = model.gates.filter((g) => g.passed).length;
  return `${String(passed)}/${String(model.gates.length)}`;
}

/** The no-answer kinds that are nouns, so their count reads "2 timeouts". */
const UNANSWERED_NOUNS = new Set(['timeout', 'provider_error', 'transport_error', 'error']);

/**
 * Trials that got no answer, in words ("3 provider errors · 1 timeout"), apart from the gates; null when
 * every trial was answered.
 */
export function unansweredText(unanswered: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(unanswered)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => {
      const words = kind.replaceAll('_', ' ');
      // Only a noun takes an s: "2 timeouts", "2 provider errors", but "rate limited: 2".
      const noun = UNANSWERED_NOUNS.has(kind);
      if (!noun) return `${words}: ${String(n)}`;
      return `${String(n)} ${n === 1 ? words : `${words}s`}`;
    });
  return parts.length === 0 ? null : parts.join(' · ');
}

/** A rate as the report gives it, to at most three places. */
export function rateText(rate: number): string {
  return String(Math.round(rate * 1000) / 1000);
}

/** A model's name in a run: the model, and its slot only when two bindings share the model. */
export function modelDisplayName(
  m: EvalModelResultDto,
  models: readonly EvalModelResultDto[],
): string {
  const shared = models.filter((other) => other.model === m.model).length > 1;
  return shared && m.slot !== null ? `${m.model} (${m.slot})` : m.model;
}

const gatesMissed = (m: EvalModelResultDto): number => m.gates.filter((g) => !g.passed).length;

/** Past this many models the verdict counts them instead of naming each. */
const VERDICT_NAMES_MAX = 3;

/** One run's outcome in plain words, from its models; the cheapest model that passes when costs are known. */
export function runVerdict(models: readonly EvalModelResultDto[]): {
  readonly verdict: string;
  readonly cheapest: string | null;
} {
  const [only] = models;
  if (only === undefined) return { verdict: 'No model results in this run.', cheapest: null };
  if (models.length === 1) {
    const worst = worstGate(only);
    const missed = gatesMissed(only);
    if (missed === 0) return { verdict: 'Passes every gate.', cheapest: null };
    const under =
      worst === null
        ? ''
        : worst.minimum === null
          ? `; furthest under: ${worst.name} failed`
          : `; furthest under: ${worst.name} ${rateText(worst.rate)} < ${rateText(worst.minimum)}`;
    return {
      verdict: `Misses ${String(missed)} of ${String(only.gates.length)} gates${under}`,
      cheapest: null,
    };
  }
  const passing = models.filter((m) => m.passed);
  const failing = models.filter((m) => !m.passed);
  const sentences: string[] = [];
  if (models.length > VERDICT_NAMES_MAX) {
    sentences.push(`${String(passing.length)} of ${String(models.length)} models pass every gate.`);
  } else {
    if (passing.length > 0) {
      const names = passing.map((m) => modelDisplayName(m, models)).join(' and ');
      sentences.push(`${names} ${passing.length === 1 ? 'passes' : 'pass'} every gate.`);
    }
    for (const m of failing) {
      sentences.push(
        `${modelDisplayName(m, models)} misses ${String(gatesMissed(m))} of ${String(m.gates.length)}.`,
      );
    }
  }
  let cheapest: string | null = null;
  const priced = passing.filter((m) => m.costUsd !== null);
  const best = priced.reduce<EvalModelResultDto | null>(
    (low, m) => (low === null || (m.costUsd ?? 0) < (low.costUsd ?? 0) ? m : low),
    null,
  );
  if (best !== null)
    cheapest = `Cheapest that passes: ${modelDisplayName(best, models)} at ${costText(best.costUsd)} a run.`;
  return { verdict: sentences.join(' '), cheapest };
}
