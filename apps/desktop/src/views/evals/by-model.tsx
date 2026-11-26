import type { EvalModelDto, EvalModelSuiteDto, ProjectId } from '@10db/contracts';
import { Group, Select, Stack, Text } from '@mantine/core';
import { IconCpu } from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useState } from 'react';
import { useEvalModels } from '../../daemon/evals-queries';
import { EmptyState } from '../../shell/empty-state';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { costText, dayText, latencyText } from './eval-figures';
import { compareRows, costDifference, shareText, type CompareRow } from './model-compare';
import { ResultDot } from './result-marks';

/** The suites a model failed, by name. */
function failedText(model: EvalModelDto): string {
  const failed = model.suites.filter((s) => !s.passed).map((s) => s.label);
  return failed.length === 0 ? 'none' : failed.join(', ');
}

/** A model's newest result in one suite: a dot, what failed it, and a note when it graded an older eval. */
function SuiteCell({ result }: { readonly result: EvalModelSuiteDto | null }) {
  if (result === null)
    return (
      <Text size="xs" c="dimmed">
        not run
      </Text>
    );
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <ResultDot passed={result.passed} />
        <Text size="sm" c={result.passed ? 'var(--mantine-color-bright)' : 'red'}>
          {result.passed ? 'passed' : `failed ${result.failedGates.join(', ')}`}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        {`${costText(result.costUsd)} · ${latencyText(result.latencyP50Ms)} · ${dayText(result.at)}`}
        {result.olderEval ? ' · older eval' : ''}
      </Text>
    </Stack>
  );
}

function ModelTable({
  models,
  picked,
  onPick,
}: {
  readonly models: readonly EvalModelDto[];
  readonly picked: string;
  readonly onPick: (model: string) => void;
}) {
  return (
    <RaisedPanel>
      <DataTable<EvalModelDto>
        aria-label="Models"
        records={[...models]}
        idAccessor="model"
        backgroundColor="transparent"
        verticalSpacing="sm"
        horizontalSpacing="md"
        highlightOnHover
        onRowClick={({ record }) => {
          onPick(record.model);
        }}
        rowStyle={(m) =>
          m.model === picked ? { background: 'var(--mantine-color-default-hover)' } : undefined
        }
        columns={[
          {
            accessor: 'model',
            title: 'Model',
            render: (m) => (
              <Stack gap={2}>
                <Text size="sm" fw={500} c="var(--mantine-color-bright)">
                  {m.model}
                </Text>
                {m.slots.length === 0 ? null : (
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {m.slots.join(' · ')}
                  </Text>
                )}
              </Stack>
            ),
          },
          {
            accessor: 'passed',
            title: 'Passed',
            textAlign: 'right',
            width: 120,
            render: (m) => (
              <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                {`${String(m.passed)} of ${String(m.suites.length)}`}
              </Text>
            ),
          },
          {
            accessor: 'failed',
            title: 'Failed',
            render: (m) => (
              <Text size="sm" c={m.passed < m.suites.length ? 'red' : 'dimmed'} lineClamp={2}>
                {failedText(m)}
              </Text>
            ),
          },
          {
            accessor: 'costUsd',
            title: 'Cost a Run',
            textAlign: 'right',
            width: 140,
            render: (m) => (
              <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                {costText(m.costUsd)}
              </Text>
            ),
          },
          {
            accessor: 'latencyP50Ms',
            title: 'p50',
            textAlign: 'right',
            width: 80,
            render: (m) => (
              <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                {latencyText(m.latencyP50Ms)}
              </Text>
            ),
          },
        ]}
      />
    </RaisedPanel>
  );
}

function CompareTable({ a, b }: { readonly a: EvalModelDto; readonly b: EvalModelDto }) {
  const rows = compareRows(a, b);
  const share = costDifference(rows);
  const differ = rows.filter((r) => r.a !== null && r.b !== null && r.a.passed !== r.b.passed);
  return (
    <Stack gap={6}>
      <Text size="sm">
        <Text span fw={600} c="var(--mantine-color-bright)">
          {`${b.model} against ${a.model}:`}
        </Text>{' '}
        {differ.length === 0
          ? 'the same result in every suite both ran'
          : `${String(differ.length)} ${differ.length === 1 ? 'suite differs' : 'suites differ'}`}
        {share === null ? '' : `, at ${shareText(share)} cost over the suites both ran`}.
      </Text>
      <RaisedPanel>
        <DataTable<CompareRow>
          aria-label="Compare models"
          records={rows}
          idAccessor="key"
          backgroundColor="transparent"
          verticalSpacing="sm"
          horizontalSpacing="md"
          columns={[
            {
              accessor: 'label',
              title: 'Suite',
              width: 260,
              render: (r) => (
                <Text size="sm" fw={500} c="var(--mantine-color-bright)">
                  {r.label}
                </Text>
              ),
            },
            { accessor: 'a', title: a.model, render: (r) => <SuiteCell result={r.a} /> },
            { accessor: 'b', title: b.model, render: (r) => <SuiteCell result={r.b} /> },
          ]}
        />
      </RaisedPanel>
    </Stack>
  );
}

/**
 * Every model the project's results graded, and two side by side: the read a model swap needs. It reads
 * only results already on disk and never runs a model.
 */
export function ByModel({ projectId }: { readonly projectId: ProjectId }) {
  const query = useEvalModels(projectId, true);
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  if (query.data === undefined)
    return query.isError ? (
      <Text size="sm" c="red">
        {query.error.message}
      </Text>
    ) : (
      <PageLoading shape={PageLoadingShape.List} label="Loading the models" />
    );
  const models = query.data.models;
  if (models.length === 0)
    return (
      <EmptyState icon={IconCpu} title="No model results yet">
        No result file in the checkout names a model. Results show here once a suite has run.
      </EmptyState>
    );
  const a = models.find((m) => m.model === picked) ?? models[0];
  if (a === undefined) return null;
  const b = models.find((m) => m.model === other && m.model !== a.model) ?? null;
  return (
    <Stack gap="md">
      <ModelTable
        models={models}
        picked={a.model}
        onPick={(model) => {
          setPicked(model);
        }}
      />
      <Group gap="sm" align="center">
        <Text size="sm">{`Compare ${a.model} with`}</Text>
        <Select
          aria-label="Compare with"
          size="xs"
          w={280}
          clearable
          checkIconPosition="right"
          placeholder="Pick a model"
          data={models.filter((m) => m.model !== a.model).map((m) => m.model)}
          value={b?.model ?? null}
          onChange={(next) => {
            setOther(next);
          }}
        />
      </Group>
      {b === null ? null : <CompareTable a={a} b={b} />}
    </Stack>
  );
}
