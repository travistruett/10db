import { ScatterChart } from '@mantine/charts';
import { Paper, Text } from '@mantine/core';
import { z } from 'zod';
import { formatCost, formatScore } from './model-format';
import { PICK_COLOR } from './role-picks-panel';
import { costTickLabel, type RightsizingSeries } from './rightsizing-series';

const TooltipPoint = z.object({ id: z.number() });

/**
 * Intelligence against cost per task: every point gray, the frontier blue, each role's need a dashed line and
 * each pick ringed. The tooltip is an opaque surface above the plot.
 */
export function RightsizingChart({
  result,
  costLabel,
  height,
}: {
  readonly result: RightsizingSeries;
  /** What the cost per task is at, which names the X axis. */
  readonly costLabel: string;
  readonly height: number;
}) {
  const frontier = result.frontier.flatMap((to, i) => {
    const from = result.frontier[i - 1];
    if (from === undefined) return [];
    return [
      {
        segment: [
          { x: from.cost, y: from.intelligence },
          { x: to.cost, y: to.intelligence },
        ] as const,
        color: 'blue.6',
        strokeWidth: 1.5,
      },
    ];
  });
  const { ticks } = result;
  const first = ticks[0];
  const last = ticks.at(-1);
  return (
    <ScatterChart
      // Recharts keeps its series from before, so a changed set of series needs a fresh chart.
      key={result.series.map((s) => s.name).join('|')}
      h={height}
      data={result.series.map((s) => ({
        name: s.name,
        color: s.color,
        data: s.data.map((d) => ({ ...d })),
      }))}
      dataKey={{ x: 'cost', y: 'intelligence' }}
      xAxisLabel={costLabel}
      yAxisLabel="Intelligence"
      xAxisProps={{
        scale: 'log',
        type: 'number',
        // A fixed 1-2-5 ladder, every rung labelled, with the axis ending on its first and last rung.
        ...(first === undefined || last === undefined || first === last
          ? { domain: ['auto', 'auto'] }
          : { domain: [first, last], ticks, interval: 0 }),
        tickFormatter: (value: number) => costTickLabel(value),
      }}
      yAxisProps={{ type: 'number', domain: [0, 'auto'] }}
      referenceLines={[
        ...frontier,
        ...result.lines.map((line) => ({
          y: line.need,
          label: line.label,
          labelPosition: 'insideTopLeft' as const,
          strokeDasharray: '4 4',
        })),
      ]}
      referenceDots={result.rings.map((ring) => ({
        x: ring.cost,
        y: ring.intelligence,
        r: 9,
        fill: 'none',
        stroke: `var(--mantine-color-${PICK_COLOR}-6)`,
        strokeWidth: 2.5,
      }))}
      tooltipProps={{
        wrapperStyle: { zIndex: 10 },
        content: ({ payload }) => {
          // The chart hands back the data item it drew; its id leads to the point.
          const parsed = TooltipPoint.safeParse(payload[0]?.payload);
          const point = parsed.success ? result.points[parsed.data.id] : undefined;
          if (point === undefined) return null;
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
              <Text size="xs">{point.effort}</Text>
              <Text size="xs">Intelligence {formatScore(point.intelligence)}</Text>
              <Text size="xs">{formatCost(point.cost)} a task</Text>
            </Paper>
          );
        },
      }}
    />
  );
}
