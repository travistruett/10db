import type { EvalModelResultDto, EvalSuiteDetailDto, ProjectId } from '@10db/contracts';
import { Code, Group, Loader, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useEvalSuite } from '../../daemon/evals-queries';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { LiveRunControls } from './live-run-modal';
import { costText, dayTimeText, gatesPassed, rateText } from './eval-figures';

/** How many runs the drawer lists before "n older runs". */
const RUNS_SHOWN = 8;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600} c="var(--mantine-color-bright)">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/** A model's binding in a run: two slots may name one model. */
const bindingOf = (m: EvalModelResultDto): string => `${m.slot ?? ''}|${m.model}`;

/** A model's name in the switch: the model, and its slot only when two bindings share the model. */
function switchName(m: EvalModelResultDto, models: readonly EvalModelResultDto[]): string {
  const shared = models.filter((other) => other.model === m.model).length > 1;
  return shared && m.slot !== null ? `${m.model} (${m.slot})` : m.model;
}

/** One model's gates, failing first, each rate against its minimum. */
function Gates({ model }: { readonly model: EvalModelResultDto }) {
  const gates = [...model.gates].sort((a, b) => Number(a.passed) - Number(b.passed));
  return (
    <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing={0} fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th c="dimmed" fw={500} fz="xs">
            Gate
          </Table.Th>
          <Table.Th c="dimmed" fw={500} fz="xs" ta="right">
            Rate
          </Table.Th>
          <Table.Th c="dimmed" fw={500} fz="xs" ta="right">
            Minimum
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {gates.map((gate) => (
          <Table.Tr key={gate.name}>
            <Table.Td>{gate.name}</Table.Td>
            <Table.Td ta="right" {...(gate.passed ? {} : { c: 'red' })}>
              {rateText(gate.rate)}
            </Table.Td>
            <Table.Td ta="right" c="dimmed">
              {gate.minimum === null ? '—' : rateText(gate.minimum)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function RunGates({ detail }: { readonly detail: EvalSuiteDetailDto }) {
  const models = detail.run?.models ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const shown =
    models.find((m) => bindingOf(m) === chosen) ?? models.find((m) => !m.passed) ?? models[0];
  if (shown === undefined) return null;
  return (
    <Section title="Gates">
      {models.length > 1 ? (
        <SegmentedControl
          size="xs"
          value={bindingOf(shown)}
          onChange={setChosen}
          data={models.map((m) => ({
            value: bindingOf(m),
            label: `${switchName(m, models)} · ${gatesPassed(m)}`,
          }))}
        />
      ) : null}
      <Gates model={shown} />
    </Section>
  );
}

/** Whether a run (newest first) graded a different eval than the run before it. */
function newEval(runs: EvalSuiteDetailDto['runs'], place: number): boolean {
  const mine = runs[place]?.fingerprint ?? null;
  // The last earlier run that recorded a fingerprint, as the trend reads it.
  const before = runs.slice(place + 1).find((r) => r.fingerprint !== null)?.fingerprint ?? null;
  return mine !== null && before !== null && mine !== before;
}

function Runs({
  detail,
  onPick,
}: {
  readonly detail: EvalSuiteDetailDto;
  readonly onPick: (path: string) => void;
}) {
  const shownPath = detail.run?.path ?? null;
  const older = detail.runs.length - RUNS_SHOWN;
  return (
    <Section title="Runs">
      <Table highlightOnHover verticalSpacing={6} fz="sm">
        <Table.Tbody>
          {detail.runs.slice(0, RUNS_SHOWN).map((run, place) => (
            <Table.Tr
              key={run.path}
              onClick={() => {
                onPick(run.path);
              }}
              style={{
                cursor: 'pointer',
                ...(run.path === shownPath
                  ? { background: 'var(--mantine-color-default-hover)' }
                  : {}),
              }}
            >
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{dayTimeText(run.at)}</Table.Td>
              <Table.Td c={run.passed ? 'dimmed' : 'red'}>
                {run.passed ? 'Passed' : 'Failed'}
              </Table.Td>
              <Table.Td c="dimmed">
                {run.models.length === 1 ? run.models[0] : `${String(run.models.length)} models`}
                {newEval(detail.runs, place) ? ' · new eval' : ''}
              </Table.Td>
              <Table.Td ta="right">{costText(run.costUsd)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {older > 0 ? (
        <Text size="xs" c="dimmed">
          {`${String(older)} older runs`}
        </Text>
      ) : null}
    </Section>
  );
}

function Manifest({
  detail,
  projectId,
}: {
  readonly detail: EvalSuiteDetailDto;
  readonly projectId: ProjectId;
}) {
  const rows: [string, ReactNode][] = [];
  if (detail.coveredPaths.length > 0)
    rows.push(['Covers', detail.coveredPaths.map((p) => <Code key={p}>{p}</Code>)]);
  if (detail.suite.definitionPaths.length > 0)
    rows.push(['Definition', detail.suite.definitionPaths.map((p) => <Code key={p}>{p}</Code>)]);
  if (detail.freeCommand !== null) rows.push(['Free Check', <Code>{detail.freeCommand}</Code>]);
  if (detail.liveCommand !== null) rows.push(['Live Run', <Code>{detail.liveCommand}</Code>]);
  if (detail.liveCommand !== null)
    rows.push(['', <LiveRunControls projectId={projectId} suiteKey={detail.suite.key} />]);
  if (rows.length === 0) return null;
  return (
    <Section title="What It Covers">
      <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing={0} fz="sm">
        <Table.Tbody>
          {rows.map(([label, value]) => (
            <Table.Tr key={label}>
              <Table.Td c="dimmed" w={96} style={{ verticalAlign: 'top' }}>
                {label}
              </Table.Td>
              <Table.Td>
                <Group gap={6}>{value}</Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

function SuiteBody({
  detail,
  projectId,
  onPick,
}: {
  readonly detail: EvalSuiteDetailDto;
  readonly projectId: ProjectId;
  readonly onPick: (path: string) => void;
}) {
  const { suite, run } = detail;
  const meta = [
    suite.definitionPaths[0] ?? null,
    run?.repeat ? `${String(run.repeat)} trials a case` : null,
    run ? `run ${dayTimeText(run.at)}` : 'no results found',
  ].filter((part): part is string => part !== null);
  // The latest run no longer measures the eval as written once its definition was committed well after it.
  const changedAfter =
    suite.definitionChangedAt !== null && run !== null && run.path === suite.latest?.path
      ? `The eval's definition was committed ${dayTimeText(suite.definitionChangedAt)}, after this run, so this result may not measure the eval as it is now.`
      : null;
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={3} fz={16} fw={600}>
          {suite.label}
        </Title>
        <Text size="xs" c="dimmed">
          {meta.join(' · ')}
        </Text>
        {suite.bar === null ? null : <Text size="sm">{suite.bar}</Text>}
        {changedAfter === null ? null : (
          <Text size="xs" c="dimmed">
            {changedAfter}
          </Text>
        )}
      </Stack>
      <RunGates key={run?.path ?? ''} detail={detail} />
      {detail.runs.length > 0 ? <Runs detail={detail} onPick={onPick} /> : null}
      {detail.flaky.length > 0 ? (
        <Section title="Flaky in the Last Runs">
          {detail.flaky.map((c) => (
            <Text key={c.name} size="sm">
              {c.name}{' '}
              <Text span size="xs" c="dimmed">
                {`failed ${String(c.failed)} of ${String(c.trials)} trials`}
              </Text>
            </Text>
          ))}
        </Section>
      ) : null}
      <Manifest detail={detail} projectId={projectId} />
    </Stack>
  );
}

/** A suite's drawer: its gates on one run, every run, flaky cases and what the manifest says of it. */
export function SuiteDrawer({
  projectId,
  suiteKey,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string | null;
  readonly onClose: () => void;
}) {
  // A run picked in one suite is never asked of another.
  const [picked, setPicked] = useState<{ readonly suite: string; readonly run: string } | null>(
    null,
  );
  const run = picked !== null && picked.suite === suiteKey ? picked.run : null;
  const detail = useEvalSuite(projectId, suiteKey, run);
  const pick = (path: string): void => {
    if (suiteKey !== null) setPicked({ suite: suiteKey, run: path });
  };
  return (
    <SurfaceDrawer
      opened={suiteKey !== null}
      onClose={() => {
        setPicked(null);
        onClose();
      }}
      label="Suite"
      widthPx={560}
      closeOnClickOutside
      {...(suiteKey === null ? {} : { showing: suiteKey })}
    >
      {detail.data ? (
        <SuiteBody detail={detail.data} projectId={projectId} onPick={pick} />
      ) : detail.isError ? (
        <Text size="sm" c="red">
          {detail.error.message}
        </Text>
      ) : (
        <Loader size="sm" />
      )}
    </SurfaceDrawer>
  );
}
