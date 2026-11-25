import { BAR_ORDER, BarPart, type BarCounts } from './factory-summary';
import classes from './factory-overview.module.css';

export const BAR_LABELS: Readonly<Record<BarPart, string>> = {
  [BarPart.Merged]: 'Merged today',
  [BarPart.Running]: 'Running',
  [BarPart.InReview]: 'In review',
  [BarPart.NeedsYou]: 'Needs you',
  [BarPart.Failed]: 'Failed',
  [BarPart.Waiting]: 'Waiting',
};

/**
 * A bar split by where work stands, one part per state in DESIGN.md's colors: green only for merged work, in
 * review striped blue. Decorative: the line beside it says the same counts in words.
 */
export function StackedBar({
  counts,
  size = 'md',
  labels = BAR_LABELS,
}: {
  readonly counts: BarCounts;
  readonly size?: 'sm' | 'md';
  readonly labels?: Readonly<Record<BarPart, string>>;
}) {
  return (
    <span className={classes['bar']} data-size={size} aria-hidden>
      {BAR_ORDER.filter((part) => counts[part] > 0).map((part) => (
        <span
          key={part}
          className={classes['segment']}
          data-part={part}
          style={{ flexGrow: counts[part] }}
          title={`${labels[part]}: ${String(counts[part])}`}
        />
      ))}
    </span>
  );
}

/** The key under the Projects heading: each part's swatch and name. */
export function BarLegend() {
  return (
    <span className={classes['legend']} aria-hidden>
      {BAR_ORDER.map((part) => (
        <span key={part} className={classes['legendItem']}>
          <span className={classes['swatch']} data-part={part} />
          {BAR_LABELS[part]}
        </span>
      ))}
    </span>
  );
}

/** A running run's steps as pips: the ones done and the one under way filled, the rest empty. */
export function StepPips({
  run,
}: {
  readonly run: {
    readonly steps: readonly { readonly role: string }[];
    readonly stepIndex: number;
  };
}) {
  if (run.steps.length === 0) return null;
  return (
    <span className={classes['pips']} aria-hidden>
      {run.steps.map((step, i) => (
        <span
          // Steps repeat roles (implement, review, implement), so the place is the key.
          key={i}
          className={classes['pip']}
          data-on={i <= run.stepIndex}
          title={step.role}
        />
      ))}
    </span>
  );
}
