import { ScatterChart } from '@mantine/charts';
import { Paper, Text } from '@mantine/core';
import { z } from 'zod';
import { formatCost, formatScore } from './model-format';
import { costTickLabel, type RightsizingSeries } from './rightsizing-series';

const TooltipPoint = z.object({ id: z.number() });

/** Intelligence against cost per task, with each role's need as a line and the router's picks ringed. */
export function RightsizingChart({
  result,
  costLabel,
}: {
  readonly result: RightsizingSeries;
  /** What the cost per task is at, which names the X axis. */
  readonly costLabel: string;
}) {
  const frontier = result.pareto.flatMap((to, i) => {
    const from = result.pareto[i - 1];
    if (from === undefined) return [];
    return [
      {
        segment: [
          { x: from.cost, y: from.intelligence },
          { x: to.cost, y: to.intelligence },
        ] as const,
        color: 'gray.6',
        strokeWidth: 1.5,
      },
    ];
  });
  const { ticks } = result;
  const first = ticks[0];
  const last = ticks.at(-1);
  return (
    <ScatterChart
      // Recharts keeps the legend's items from before, and Mantine's legend reads the series by index, so a changed
      // set of tiers needs a fresh chart.
      key={result.series.map((s) => s.name).join('|')}
      h={420}
      withLegend
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
      referenceAreas={
        result.area === null
          ? []
          : [
              {
                y1: result.area.need,
                y2: result.area.top,
                x2: result.area.cost,
                color: 'teal.6',
                ifOverflow: 'hidden' as const,
              },
            ]
      }
      referenceDots={result.rings.map((ring) => ({
        x: ring.cost,
        y: ring.intelligence,
        r: 9,
        fill: 'none',
        stroke: 'var(--mantine-color-orange-6)',
        strokeWidth: 2.5,
        opacity: ring.dimmed ? 0.25 : 1,
      }))}
      tooltipProps={{
        content: ({ payload }) => {
          // The chart hands back the data item it drew; its id leads to the point.
          const parsed = TooltipPoint.safeParse(payload[0]?.payload);
          const point = parsed.success ? result.points[parsed.data.id] : undefined;
          if (point === undefined) return null;
          return (
            <Paper px="sm" py="xs" withBorder shadow="sm">
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
