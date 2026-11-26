import {
  EvalCoverageState,
  type EvalCoverageSideDto,
  type EvalCoverageSuiteDto,
  type EvalMarkerDto,
  type TaskId,
} from '@10db/contracts';
import { Code, Group, Stack, Text } from '@mantine/core';
import { useTaskEvalCoverage } from '../../daemon/evals-queries';

// A task whose change touched a suite's covered code says where that suite stands: "not run" until the builder
// runs the suite's live command in their checkout after the task lands, then passing, failing or regressed. The
// card shows one line per suite; the drawer shows the results either side of the task. Status is text, never a pill.

const STATE_WORDS: Readonly<Record<EvalCoverageState, string>> = {
  [EvalCoverageState.NotRun]: 'not run',
  [EvalCoverageState.Passing]: 'passing',
  [EvalCoverageState.Failing]: 'failing',
  [EvalCoverageState.Regressed]: 'regressed',
  [EvalCoverageState.EvalChanged]: 'the eval itself changed',
};

const STATE_COLOR: Readonly<Record<EvalCoverageState, string>> = {
  [EvalCoverageState.NotRun]: 'dimmed',
  [EvalCoverageState.Passing]: 'green',
  [EvalCoverageState.Failing]: 'red',
  [EvalCoverageState.Regressed]: 'red',
  [EvalCoverageState.EvalChanged]: 'yellow',
};

/** The card's lines, one per touched suite; nothing when the task touched none. */
export function EvalMarkerLines({ markers }: { readonly markers: readonly EvalMarkerDto[] }) {
  return (
    <>
      {markers.map((m) => (
        <Text
          key={m.suiteKey}
          size="xs"
          c={STATE_COLOR[m.state]}
          data-testid="eval-marker"
          lineClamp={1}
        >
          {`${m.label} · ${STATE_WORDS[m.state]}`}
        </Text>
      ))}
    </>
  );
}

function resultWords(side: EvalCoverageSideDto | null, none: string): string {
  if (side === null) return none;
  const failing = side.models.filter((m) => !m.passed).map((m) => m.model);
  const verdict = side.passed
    ? 'passed'
    : `failed${failing.length > 0 ? ` (${failing.join(', ')})` : ''}`;
  return `${verdict}, ${side.at.slice(0, 10)}`;
}

function Suite({ suite }: { readonly suite: EvalCoverageSuiteDto }) {
  return (
    <Stack gap={4} data-testid="eval-coverage-suite">
      <Group gap="xs" wrap="nowrap" align="baseline">
        <Text size="sm" fw={600}>
          {suite.label}
        </Text>
        <Text size="sm" c={STATE_COLOR[suite.state]}>
          {STATE_WORDS[suite.state]}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {`Changes ${suite.paths.join(', ')}`}
      </Text>
      <Text size="sm">{`Before: ${resultWords(suite.before, 'no result before this task')}`}</Text>
      <Text size="sm">
        {`After: ${resultWords(suite.after, 'none yet; run the live command in your checkout once it lands')}`}
      </Text>
      {suite.liveCommand === null ? null : <Code block>{suite.liveCommand}</Code>}
    </Stack>
  );
}

/** The drawer's block, beside For You; nothing when the task touched no covered suite. */
export function TaskEvalCoverage({ taskId }: { readonly taskId: TaskId | undefined }) {
  const coverage = useTaskEvalCoverage(taskId).data;
  if (coverage === undefined || coverage.suites.length === 0) return null;
  return (
    <Stack gap="xs" data-testid="eval-coverage">
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Evals
      </Text>
      {coverage.suites.map((suite) => (
        <Suite key={suite.suiteKey} suite={suite} />
      ))}
    </Stack>
  );
}
