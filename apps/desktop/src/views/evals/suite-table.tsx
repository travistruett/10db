import type { EvalSuiteDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { RaisedPanel } from '../../shell/raised-panel';
import { dayText, latencyText, modelCostsText } from './eval-figures';
import { ModelLine, Trend } from './result-marks';

const COLUMNS: DataTableColumn<EvalSuiteDto>[] = [
  {
    accessor: 'key',
    title: 'Suite',
    render: (suite) => (
      <Stack gap={2}>
        <Text size="sm" fw={500} c="var(--mantine-color-bright)">
          {suite.label}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1} title={suite.bar ?? undefined}>
          {suite.bar ?? suite.definitionPaths[0] ?? suite.key}
        </Text>
      </Stack>
    ),
  },
  {
    accessor: 'latest',
    title: 'Last Result per Model',
    render: (suite) =>
      suite.latest === null ? (
        <Text size="xs" c="dimmed">
          {suite.format === null ? 'No results committed' : 'No run could be read'}
        </Text>
      ) : (
        <Stack gap={4}>
          {suite.latest.models.map((model) => (
            <ModelLine key={`${model.slot ?? ''}${model.model}`} result={model} />
          ))}
        </Stack>
      ),
  },
  {
    accessor: 'trend',
    title: 'Trend',
    width: 110,
    render: (suite) => <Trend runs={suite.trend} />,
  },
  {
    accessor: 'cost',
    title: 'Cost a Run',
    textAlign: 'right',
    width: 120,
    render: (suite) => (
      <Text
        size="sm"
        {...(suite.latest === null ? { c: 'dimmed' } : {})}
        style={{ whiteSpace: 'nowrap' }}
      >
        {suite.latest === null ? '—' : modelCostsText(suite.latest.models)}
      </Text>
    ),
  },
  {
    accessor: 'p50',
    title: 'p50',
    textAlign: 'right',
    width: 70,
    render: (suite) => (
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {latencyText(suite.latest?.models[0]?.latencyP50Ms ?? null)}
      </Text>
    ),
  },
  {
    accessor: 'at',
    title: 'Last Run',
    textAlign: 'right',
    width: 90,
    render: (suite) => (
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {suite.latest === null ? '—' : dayText(suite.latest.at)}
      </Text>
    ),
  },
];

/** A project's suites as one raised table; clicking a row opens its drawer. */
export function SuiteTable({
  suites,
  openKey,
  onOpen,
}: {
  readonly suites: readonly EvalSuiteDto[];
  readonly openKey: string | null;
  readonly onOpen: (suite: EvalSuiteDto) => void;
}) {
  return (
    <RaisedPanel>
      <DataTable<EvalSuiteDto>
        aria-label="Suites"
        records={[...suites]}
        columns={COLUMNS}
        idAccessor="key"
        backgroundColor="transparent"
        verticalSpacing="sm"
        horizontalSpacing="md"
        highlightOnHover
        onRowClick={({ record }) => {
          onOpen(record);
        }}
        customRowAttributes={() => ({ 'data-keeps-drawer': '' })}
        rowStyle={(suite) =>
          suite.key === openKey ? { background: 'var(--mantine-color-default-hover)' } : undefined
        }
      />
    </RaisedPanel>
  );
}
