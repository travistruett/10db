import { JUDGE_TIMEOUT_MS, type DecisionModelDto } from '@10db/contracts';
import { ScatterChart } from '@mantine/charts';
import { Paper, Text } from '@mantine/core';
import { z } from 'zod';
import { DECISIONS } from './decision-catalogue';
import { costAxis, ringLabel, type DecisionModelPoint } from './decision-model-series';
import { formatDecisionUsd } from './decision-numbers';
import { decisionSourceText } from './number-source';
import { PICK_COLOR } from './pick-color';
import { costTickLabel, costTicks } from './rightsizing-series';

const TooltipPoint = z.object({ id: z.number() });

const FALLBACK_SECONDS = JUDGE_TIMEOUT_MS / 1000;

/** What a decision's time reads as on an axis tick: seconds, or milliseconds under one. */
const secondsLabel = (value: number): string =>
  value < 1 ? `${String(Math.round(value * 1000))} ms` : `${String(value)} s`;

/**
 * Seconds per decision against cost per million decisions, both on log axes: a gray dot per model, a dashed line
 * where 10db gives up on a model, and a violet ring on each model a decision uses. A free model sits at `freeX`,
 * which the axis calls Free.
 */
export function DecisionModelsChart({
  points,
  freeX,
  models,
  height,
}: {
  readonly points: readonly DecisionModelPoint[];
  readonly freeX: number | null;
  readonly models: readonly DecisionModelDto[];
  readonly height: number;
}) {
  const xAxis = costAxis(
    points.map((p) => p.x),
    freeX,
  );
  const seconds = points.map((p) => p.secondsPerDecision);
  // The cutoff line is always inside the axis, so a model past it reads as past it.
  const yTicks = costTicks(
    Math.min(...seconds, FALLBACK_SECONDS),
    Math.max(...seconds, FALLBACK_SECONDS),
  );
  const yFirst = yTicks[0];
  const yLast = yTicks.at(-1);
  return (
    <ScatterChart
      key={points.map((p) => p.id).join('|')}
      h={height}
      data={[
        {
          name: 'Decision models',
          color: 'gray.6',
          data: points.map((p, id) => ({ id, x: p.x, seconds: p.secondsPerDecision })),
        },
      ]}
      dataKey={{ x: 'x', y: 'seconds' }}
      xAxisLabel="Cost per million decisions (USD, log scale)"
      yAxisLabel="Seconds per decision (log scale)"
      xAxisProps={{
        scale: 'log',
        type: 'number',
        ...(xAxis === null
          ? { domain: ['auto', 'auto'] }
          : { domain: [...xAxis.domain], ticks: [...xAxis.ticks], interval: 0 }),
        tickFormatter: (value: number) => (value === freeX ? 'Free' : costTickLabel(value)),
      }}
      yAxisProps={{
        scale: 'log',
        type: 'number',
        ...(yFirst === undefined || yLast === undefined || yFirst === yLast
          ? { domain: ['auto', 'auto'] }
          : { domain: [yFirst, yLast], ticks: yTicks, interval: 0 }),
        tickFormatter: (value: number) => secondsLabel(value),
      }}
      strokeDasharray="0"
      gridColor="var(--mantine-color-default-border)"
      referenceLines={[
        {
          y: FALLBACK_SECONDS,
          label: `${String(FALLBACK_SECONDS)} s: 10db falls back past this`,
          labelPosition: 'insideTopLeft',
          strokeDasharray: '4 4',
        },
      ]}
      referenceDots={points
        .filter((p) => p.usedBy.length > 0)
        .map((p) => ({
          x: p.x,
          y: p.secondsPerDecision,
          r: 9,
          fill: 'none',
          stroke: `var(--mantine-color-${PICK_COLOR}-6)`,
          strokeWidth: 2.5,
          label: ringLabel(p.usedBy),
        }))}
      tooltipProps={{
        wrapperStyle: { zIndex: 10 },
        content: ({ payload }) => {
          const parsed = TooltipPoint.safeParse(payload[0]?.payload);
          const point = parsed.success ? points[parsed.data.id] : undefined;
          if (point === undefined) return null;
          const model = models.find((m) => m.id === point.id);
          return (
            <Paper
              px="sm"
              py="xs"
              withBorder
              shadow="sm"
              style={{
                background: 'var(--mantine-color-default)',
                borderColor: 'var(--mantine-color-default-border)',
              }}
            >
              <Text size="sm" fw={500}>
                {point.name}
              </Text>
              <Text size="xs">
                {point.free ? 'Free' : formatDecisionUsd(point.costPerMillionUsd)} per million
                decisions
              </Text>
              {model?.costSource == null ? null : (
                <Text size="xs" c="dimmed">
                  {decisionSourceText(model.costSource)}
                </Text>
              )}
              <Text size="xs">{secondsLabel(point.secondsPerDecision)} a decision</Text>
              {model?.timeSource == null ? null : (
                <Text size="xs" c="dimmed">
                  {decisionSourceText(model.timeSource)}
                </Text>
              )}
              {point.usedBy.length === 0 ? null : (
                <Text size="xs">
                  Used by {point.usedBy.map((d) => DECISIONS[d].label).join(', ')}
                </Text>
              )}
            </Paper>
          );
        },
      }}
    />
  );
}
