import { Group, Progress, Text, Tooltip, type MantineColor } from '@mantine/core';
import { BAR_ORDER, BarPart, type BarCounts } from './factory-summary';

export const BAR_LABELS: Readonly<Record<BarPart, string>> = {
  [BarPart.Merged]: 'Merged today',
  [BarPart.Running]: 'Running',
  [BarPart.InReview]: 'In review',
  [BarPart.NeedsYou]: 'Needs you',
  [BarPart.Failed]: 'Failed',
  [BarPart.Waiting]: 'Waiting',
};

/** DESIGN.md's status colors: green only for merged work, in review is running's blue, striped. */
const PART_COLORS: Readonly<Record<BarPart, MantineColor>> = {
  [BarPart.Merged]: 'green',
  [BarPart.Running]: 'blue',
  [BarPart.InReview]: 'blue',
  [BarPart.NeedsYou]: 'yellow',
  [BarPart.Failed]: 'red',
  [BarPart.Waiting]: 'gray',
};

/**
 * A bar split by where work stands, one section per state. Decorative: the line beside it says the same
 * counts in words, and each section's tooltip names its part.
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
  const total = BAR_ORDER.reduce((n, part) => n + counts[part], 0);
  return (
    <Progress.Root
      size={size === 'sm' ? 6 : 8}
      w={size === 'sm' ? 140 : '100%'}
      style={{ flex: 'none' }}
      aria-hidden
    >
      {BAR_ORDER.filter((part) => counts[part] > 0).map((part) => (
        <Tooltip key={part} label={`${labels[part]}: ${String(counts[part])}`}>
          <Progress.Section
            value={(counts[part] / total) * 100}
            color={PART_COLORS[part]}
            striped={part === BarPart.InReview}
          />
        </Tooltip>
      ))}
    </Progress.Root>
  );
}

/** One part's swatch: a short bar in its color, striped for in review, as the bars draw it. */
export function BarSwatch({ part }: { readonly part: BarPart }) {
  return (
    <Progress
      value={100}
      size={8}
      w={12}
      color={PART_COLORS[part]}
      striped={part === BarPart.InReview}
      style={{ flex: 'none' }}
      aria-hidden
    />
  );
}

/** The key under the Projects heading: each part's swatch and name. */
export function BarLegend() {
  return (
    <Group gap={14} aria-hidden>
      {BAR_ORDER.map((part) => (
        <Group key={part} gap={5} wrap="nowrap">
          <BarSwatch part={part} />
          <Text size="xs" c="dimmed">
            {BAR_LABELS[part]}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

/** How far a running run is through its steps, with the steps named in the tooltip. */
export function StepProgress({
  run,
}: {
  readonly run: {
    readonly steps: readonly { readonly role: string }[];
    readonly stepIndex: number;
  };
}) {
  if (run.steps.length === 0) return null;
  return (
    <Tooltip label={run.steps.map((s) => s.role).join(' → ')}>
      <Progress
        value={((run.stepIndex + 1) / run.steps.length) * 100}
        size={4}
        w={80}
        color="blue"
        aria-hidden
      />
    </Tooltip>
  );
}
