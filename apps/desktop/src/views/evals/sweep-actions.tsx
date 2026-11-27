import {
  EvalSweepState,
  NewEvalOrigin,
  type EvalSuiteDetailDto,
  type NewEvalBody,
  type ProjectId,
} from '@10db/contracts';
import { Anchor, Button, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useEvalLivePreview, useLatestEvalSweep, useNewEvalTask } from '../../daemon/evals-queries';
import { costText } from './eval-figures';
import { sweepVerdict, TryMode, TryModelsModal } from './try-models-modal';

/** The cheapest model that passes every gate in the suite's shown run, when its cost is known. */
function cheapestPass(detail: EvalSuiteDetailDto): number | null {
  const costs = (detail.run?.models ?? []).flatMap((m) =>
    m.passed && m.costUsd !== null ? [m.costUsd] : [],
  );
  return costs.length === 0 ? null : Math.min(...costs);
}

/** The task that has the suite's live command read its models from an env var 10db sets. */
function pickModelsRequest(detail: EvalSuiteDetailDto): NewEvalBody {
  return {
    behavior: `${detail.suite.label} takes its models from 10db`.slice(0, 150),
    goal: '',
    decision: '',
    evidence: [
      `Suite: ${detail.suite.key}`,
      detail.liveCommand === null ? '' : `Live command: ${detail.liveCommand}`,
      detail.suite.definitionPaths.length > 0
        ? `Definition: ${detail.suite.definitionPaths.join(', ')}`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    oracle: '',
    coverageAndBar: '',
    models: '',
    execution: '',
    cases: [],
    check: null,
    checkRule: '',
    bar: null,
    modelIds: [],
    costCapUsd: null,
    pick: null,
    where: [],
    origin: NewEvalOrigin.PickModels,
  };
}

function PickModelsAction({
  detail,
  projectId,
}: {
  readonly detail: EvalSuiteDetailDto;
  readonly projectId: ProjectId;
}) {
  const file = useNewEvalTask(projectId);
  return (
    <>
      <Text size="xs" c="dimmed">
        {"This suite's command doesn't take models from 10db yet."}
      </Text>
      {file.data === undefined ? (
        <Button
          size="compact-sm"
          variant="default"
          loading={file.isPending}
          onClick={() => {
            file.mutate(pickModelsRequest(detail));
          }}
        >
          Let 10db Pick Models
        </Button>
      ) : (
        <Text size="xs">
          Task created:{' '}
          <Anchor
            size="xs"
            renderRoot={(props) => <Link {...props} to="/board" search={{ task: file.data.id }} />}
          >
            {file.data.title}
          </Anchor>
        </Text>
      )}
      {file.isError ? (
        <Text size="xs" c="red">
          {file.error.message}
        </Text>
      ) : null}
    </>
  );
}

/**
 * The model actions beside a suite's Run: Try Other Models and Find Cheapest Passing where the suite takes models
 * from 10db, else Let 10db Pick Models. A running or recent sweep is found again here after a reopen.
 */
export function SweepActions({
  detail,
  projectId,
}: {
  readonly detail: EvalSuiteDetailDto;
  readonly projectId: ProjectId;
}) {
  const suiteKey = detail.suite.key;
  const preview = useEvalLivePreview(projectId, suiteKey, true);
  const latest = useLatestEvalSweep(projectId, suiteKey);
  const [mode, setMode] = useState<TryMode | null>(null);
  if (preview.data === undefined) return null;
  if (preview.data.models === null)
    return <PickModelsAction detail={detail} projectId={projectId} />;
  const sweep = latest.data ?? null;
  const running = sweep?.state === EvalSweepState.Running;
  return (
    <>
      <Button
        size="compact-sm"
        variant="default"
        disabled={running}
        onClick={() => {
          setMode(TryMode.Try);
        }}
      >
        Try Other Models
      </Button>
      <Button
        size="compact-sm"
        variant="default"
        disabled={running}
        onClick={() => {
          setMode(TryMode.Cheapest);
        }}
      >
        Find Cheapest Passing
      </Button>
      {sweep === null ? null : (
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={() => {
            setMode(TryMode.Window);
          }}
        >
          {running
            ? `Sweep running · ${costText(sweep.spentUsd)} of ${costText(sweep.capUsd)}`
            : `Last sweep: ${sweepVerdict(sweep).split('.')[0] ?? ''}`}
        </Button>
      )}
      <TryModelsModal
        projectId={projectId}
        suiteKey={suiteKey}
        mode={mode}
        cheapestPassUsd={cheapestPass(detail)}
        onClose={() => {
          setMode(null);
        }}
      />
    </>
  );
}
