import type { StepRole } from '@10db/contracts';
import { Badge, Group, Progress, Stack, Text, Tooltip, type MantineColor } from '@mantine/core';
import { BAR_ORDER, BarPart, type BarCounts } from './factory-summary';
import { STEP_LABEL } from './task-rows';

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
 * A bar split by where work stands, one section per state. Decorative: the words beside it say the same
 * counts. Each section's tooltip names its part, unless the bar sits in a hover card's target that lists
 * every part (`tips` off).
 */
export function StackedBar({
  counts,
  size = 'md',
  labels = BAR_LABELS,
  tips = true,
}: {
  readonly counts: BarCounts;
  readonly size?: 'sm' | 'md';
  readonly labels?: Readonly<Record<BarPart, string>>;
  readonly tips?: boolean;
}) {
  const total = BAR_ORDER.reduce((n, part) => n + counts[part], 0);
  return (
    <Progress.Root
      // A goal's bar is thinner than its project's, which runs over it.
      size={size === 'sm' ? 4 : 6}
      w="100%"
      maw={size === 'sm' ? 140 : undefined}
      style={{ flex: 'none' }}
      aria-hidden
    >
      {BAR_ORDER.filter((part) => counts[part] > 0).map((part) => {
        const section = (
          <Progress.Section
            key={part}
            value={(counts[part] / total) * 100}
            color={PART_COLORS[part]}
            striped={part === BarPart.InReview}
          />
        );
        return tips ? (
          <Tooltip key={part} label={`${labels[part]}: ${String(counts[part])}`}>
            {section}
          </Tooltip>
        ) : (
          section
        );
      })}
    </Progress.Root>
  );
}

/** One part's swatch: a short bar in its color, striped for in review, as the bars draw it. */
export function BarSwatch({ part }: { readonly part: BarPart }) {
  return (
    <Progress
      value={100}
      size={6}
      w={10}
      color={PART_COLORS[part]}
      striped={part === BarPart.InReview}
      style={{ flex: 'none' }}
      aria-hidden
    />
  );
}

/**
 * What a project's bar is made of, for its hover card: each part with work in it, in the bar's order, as its
 * swatch, name and count. A project with nothing open says so in one dim line.
 */
export function BarBreakdown({ counts }: { readonly counts: BarCounts }) {
  const parts = BAR_ORDER.filter((part) => counts[part] > 0);
  if (parts.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Idle · nothing open
      </Text>
    );
  }
  return (
    <Stack gap={6}>
      {parts.map((part) => (
        <Group key={part} gap={8} wrap="nowrap">
          <BarSwatch part={part} />
          <Text size="xs" style={{ flex: 1 }}>
            {BAR_LABELS[part]}
          </Text>
          <Text size="xs" ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {counts[part]}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

/** A running run's step in words, with its place in the plan: "Implement 2/4". */
export function stepLabel(run: {
  readonly steps: readonly { readonly role: StepRole }[];
  readonly stepIndex: number;
}): string | null {
  const current = run.steps[run.stepIndex];
  if (current === undefined) return null;
  return `${STEP_LABEL[current.role]} ${String(run.stepIndex + 1)}/${String(run.steps.length)}`;
}

/**
 * How far a running run is through its steps, as Mantine's segmented progress: one segment per step (done
 * solid, the current one striped and moving, the rest an empty track), each naming its step in a tooltip.
 */
export function StepProgress({
  run,
}: {
  readonly run: {
    readonly steps: readonly { readonly role: StepRole }[];
    readonly stepIndex: number;
  };
}) {
  return (
    <Group grow gap={4} w="100%" maw={120} wrap="nowrap" aria-hidden>
      {run.steps.map((step, i) => (
        <Tooltip key={`${String(i)}-${step.role}`} label={STEP_LABEL[step.role]}>
          <Progress
            size="sm"
            color="blue"
            value={i <= run.stepIndex ? 100 : 0}
            striped={i === run.stepIndex}
            animated={i === run.stepIndex}
            transitionDuration={0}
          />
        </Tooltip>
      ))}
    </Group>
  );
}

/** The model a run's step runs on, as a small monospace badge. */
export function ModelBadge({ model }: { readonly model: string }) {
  return (
    <Badge size="xs" variant="default" ff="monospace" tt="none" fw={500} maw="100%">
      {model}
    </Badge>
  );
}
