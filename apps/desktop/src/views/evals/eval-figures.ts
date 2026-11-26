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

/**
 * Trials that got no answer, in words ("3 provider errors · 1 timeout"), apart from the gates; null when
 * every trial was answered.
 */
export function unansweredText(unanswered: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(unanswered)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => {
      const words = kind.replaceAll('_', ' ');
      return `${String(n)} ${n === 1 ? words : `${words}s`}`;
    });
  return parts.length === 0 ? null : parts.join(' · ');
}

/** A rate as the report gives it, to at most three places. */
export function rateText(rate: number): string {
  return String(Math.round(rate * 1000) / 1000);
}
