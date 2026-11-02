import { Badge, Group, Tooltip, type MantineColor } from '@mantine/core';

/**
 * A small labelled mark on a card that says the task has a property worth knowing (readable board spec
 * §3). Later kinds (eval, query count, schema, decisions, feedback) are more entries in the list the
 * row takes; the card does not change shape for them.
 */
export interface Indicator {
  /** Names the kind; also the test id suffix and the React key. */
  readonly kind: string;
  readonly label: string;
  readonly color: MantineColor;
  /** Shown on hover, for what the label leaves out. */
  readonly tooltip?: string | undefined;
}

/** The card's last row of indicators; nothing at all when the list is empty. */
export function IndicatorRow({ indicators }: { readonly indicators: readonly Indicator[] }) {
  if (indicators.length === 0) return null;
  return (
    <Group gap={6} data-testid="indicator-row">
      {indicators.map((indicator) => (
        <Tooltip
          key={indicator.kind}
          label={indicator.tooltip}
          disabled={!indicator.tooltip}
          withArrow
          multiline
          maw={320}
          openDelay={300}
        >
          <Badge
            size="sm"
            variant="light"
            color={indicator.color}
            tt="none"
            fw={500}
            data-testid={`indicator-${indicator.kind}`}
          >
            {indicator.label}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}
