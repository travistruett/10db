import { Group, Paper, SimpleGrid, Skeleton, Stack } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { useLoadingDelayElapsed } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { EVAL_COLUMN_WIDTHS } from './evals-table';

const ROWS = [0, 1, 2, 3, 4] as const;
const TREND_DOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

function TilePlaceholder() {
  return (
    <Paper variant="raised" radius="md" px={16} py={14}>
      <Skeleton height={24} width={36} />
      <Group gap={6} mt={12} wrap="nowrap" align="center">
        <Skeleton height={8} width={8} circle />
        <Skeleton height={10} width="55%" />
      </Group>
    </Paper>
  );
}

const alignRight = { display: 'flex', justifyContent: 'flex-end' } as const;

/**
 * What the Evals page shows while its first read loads: four tile placeholders over a raised table with the real
 * headings and rows whose cells mimic the data. It waits out the same short delay as the other pages.
 */
export function EvalsSkeleton() {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  return (
    <Stack gap="md" role="status" aria-label="Loading the evals">
      <SimpleGrid cols={4} spacing={12}>
        {[0, 1, 2, 3].map((i) => (
          <TilePlaceholder key={i} />
        ))}
      </SimpleGrid>
      <RaisedPanel>
        <DataTable<number>
          aria-label="Loading the evals table"
          records={[...ROWS]}
          idAccessor={(i) => String(i)}
          backgroundColor="transparent"
          verticalSpacing="sm"
          horizontalSpacing="md"
          columns={[
            {
              accessor: 'name',
              title: 'Name',
              width: 260,
              render: (i) => (
                <Stack gap={6}>
                  <Skeleton height={12} width={`${String(55 + ((i * 13) % 30))}%`} />
                  <Skeleton height={10} width={`${String(75 + ((i * 7) % 20))}%`} />
                </Stack>
              ),
            },
            {
              accessor: 'result',
              title: 'Last Result per Model',
              render: (i) => (
                <Stack gap={6}>
                  <Group gap={8} wrap="nowrap">
                    <Skeleton height={8} width={8} circle />
                    <Skeleton height={12} width={`${String(110 + ((i * 17) % 50))}px`} />
                  </Group>
                  <Skeleton height={10} width={90} ml={16} />
                </Stack>
              ),
            },
            {
              accessor: 'trend',
              title: 'Trend',
              width: EVAL_COLUMN_WIDTHS.trend,
              render: () => (
                <Group gap={4} wrap="nowrap">
                  {TREND_DOTS.map((d) => (
                    <Skeleton key={d} height={8} width={8} circle />
                  ))}
                </Group>
              ),
            },
            {
              accessor: 'cost',
              title: 'Cost a Run',
              textAlign: 'right',
              width: EVAL_COLUMN_WIDTHS.cost,
              render: () => (
                <div style={alignRight}>
                  <Skeleton height={12} width={56} />
                </div>
              ),
            },
            {
              accessor: 'p50',
              title: 'p50',
              textAlign: 'right',
              width: EVAL_COLUMN_WIDTHS.p50,
              render: () => (
                <div style={alignRight}>
                  <Skeleton height={12} width={36} />
                </div>
              ),
            },
            {
              accessor: 'at',
              title: 'Last Run',
              textAlign: 'right',
              width: EVAL_COLUMN_WIDTHS.at,
              render: () => (
                <div style={alignRight}>
                  <Skeleton height={12} width={64} />
                </div>
              ),
            },
            { accessor: 'action', title: '', width: EVAL_COLUMN_WIDTHS.action, render: () => null },
          ]}
        />
      </RaisedPanel>
    </Stack>
  );
}
