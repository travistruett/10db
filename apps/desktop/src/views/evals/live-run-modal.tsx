import {
  EvalLiveRefusal,
  EvalLiveRunState,
  type EvalLivePreviewDto,
  type EvalLiveRunDto,
  type ProjectId,
} from '@10db/contracts';
import { Button, Code, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCopy } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import {
  useEvalLivePreview,
  useEvalLiveRuns,
  useStartEvalLive,
  useStopEvalLive,
} from '../../daemon/evals-queries';
import { SettingsSectionKey } from '../settings/sections';
import { costText, dayTimeText } from './eval-figures';

const REFUSAL_WORDS: Readonly<Record<EvalLiveRefusal, string>> = {
  [EvalLiveRefusal.NoLive]: "The assessment hasn't said how this command runs.",
  [EvalLiveRefusal.NoSandbox]: "This 10db runs no sandbox, so it can't run a live eval.",
  [EvalLiveRefusal.DockerOff]: "This runs in Docker and the project's Docker switch is off.",
  [EvalLiveRefusal.ManifestChanged]: 'What the suite runs changed since this window opened.',
  [EvalLiveRefusal.Busy]: 'A live eval is already running in this project.',
};

const STATE_WORDS: Readonly<Record<EvalLiveRunState, string>> = {
  [EvalLiveRunState.Running]: 'Running',
  [EvalLiveRunState.Passed]: 'Finished',
  [EvalLiveRunState.Failed]: 'Failed',
  [EvalLiveRunState.Stopped]: 'Stopped',
  [EvalLiveRunState.TimedOut]: 'Stopped at its time limit',
  [EvalLiveRunState.Interrupted]: 'Interrupted when 10db stopped',
};

/** The run in words: its state and, once it ended, the exit code. */
function runWords(run: EvalLiveRunDto): string {
  const code = run.exitCode === null ? '' : `, exit code ${String(run.exitCode)}`;
  return `${STATE_WORDS[run.state]}${run.state === EvalLiveRunState.Running ? '' : code}`;
}

function elapsedText(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function Elapsed({ startedAt }: { readonly startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <>{elapsedText(startedAt, now)}</>;
}

function Notes({ preview }: { readonly preview: EvalLivePreviewDto }) {
  const lines: string[] = [];
  if (preview.docker) {
    lines.push(
      'Runs in your containers, with their keys and network. Needs your stack running.',
      preview.envFiles.length > 0 ? `Compose may read: ${preview.envFiles.join(', ')}` : '',
    );
  } else {
    lines.push(preview.hosts.length > 0 ? `May reach: ${preview.hosts.join(', ')}` : 'No hosts');
  }
  lines.push(
    preview.stopCommand !== null
      ? `Stop also runs: ${preview.stopCommand}`
      : preview.docker
        ? "Stop ends 10db's side; work in your containers may keep running"
        : 'Stop ends the command',
    `Stops after ${String(preview.timeoutMinutes)} minutes`,
    preview.lastRunCostUsd === null
      ? 'Last run cost unknown'
      : `Last run ${costText(preview.lastRunCostUsd)}`,
  );
  return (
    <Stack gap={4}>
      {lines
        .filter((l) => l !== '')
        .map((l) => (
          <Text key={l} size="sm" style={{ overflowWrap: 'anywhere' }}>
            {l}
          </Text>
        ))}
    </Stack>
  );
}

function RunView({
  projectId,
  run,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly run: EvalLiveRunDto;
  readonly onClose: () => void;
}) {
  const stop = useStopEvalLive(projectId);
  const running = run.state === EvalLiveRunState.Running;
  return (
    <Stack gap="sm" data-testid="live-run">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>
          {runWords(run)}
          {running ? (
            <>
              {' · '}
              <Elapsed startedAt={run.startedAt} />
            </>
          ) : null}
        </Text>
        {running ? (
          <Button
            size="xs"
            color="red"
            variant="light"
            loading={stop.isPending}
            onClick={() => {
              stop.mutate(run.id);
            }}
          >
            Stop
          </Button>
        ) : (
          <Button size="xs" variant="default" onClick={onClose}>
            Close
          </Button>
        )}
      </Group>
      {run.state === EvalLiveRunState.Interrupted && !run.stopRan ? (
        <Text size="sm" c="yellow">
          The work in your containers may still be running.
        </Text>
      ) : null}
      {run.state === EvalLiveRunState.Passed ? (
        <Text size="xs" c="dimmed">
          Exit 0 means the command ran; the eval's verdict is the result it wrote, on the Evals
          page.
        </Text>
      ) : null}
      {run.tail === '' ? null : (
        <Code block mah={240} style={{ overflow: 'auto' }}>
          {run.tail}
        </Code>
      )}
    </Stack>
  );
}

function Confirm({
  projectId,
  suiteKey,
  preview,
  onStarted,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly preview: EvalLivePreviewDto;
  readonly onStarted: (run: EvalLiveRunDto) => void;
}) {
  const start = useStartEvalLive(projectId, suiteKey);
  const navigate = useNavigate();
  const [changed, setChanged] = useState(false);
  const refusal = preview.refusal;
  return (
    <Stack gap="md">
      <Code block>{preview.command}</Code>
      {changed ? (
        <Text size="sm" c="yellow">
          This window now shows what changed. Check it, then press Run.
        </Text>
      ) : null}
      {refusal !== null ? (
        <Stack gap={6}>
          <Text size="sm" c="red" data-testid="live-refusal">
            {REFUSAL_WORDS[refusal]}
          </Text>
          {refusal === EvalLiveRefusal.DockerOff ? (
            <Button
              size="xs"
              variant="default"
              w="fit-content"
              onClick={() => {
                void navigate({
                  to: '/settings/$section',
                  params: { section: SettingsSectionKey.NetworkHosts },
                });
              }}
            >
              Open Settings › Allow Docker
            </Button>
          ) : null}
        </Stack>
      ) : (
        <>
          <Notes preview={preview} />
          {start.isError &&
          !(start.error instanceof DaemonRequestError && start.error.status === 409) ? (
            <Text size="sm" c="red">
              {start.error.message}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button
              loading={start.isPending}
              onClick={() => {
                start.mutate(preview.previewHash, {
                  onSuccess: onStarted,
                  onError: (error) => {
                    if (error instanceof DaemonRequestError && error.status === 409)
                      setChanged(true);
                  },
                });
              }}
            >
              Run
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

function RunModal({
  projectId,
  suiteKey,
  opened,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const preview = useEvalLivePreview(projectId, suiteKey, opened);
  const runs = useEvalLiveRuns(projectId, suiteKey);
  const [runId, setRunId] = useState<string | null>(null);
  const run = runs.data?.find((r) => r.id === runId) ?? null;
  return (
    <Modal
      opened={opened}
      onClose={() => {
        setRunId(null);
        onClose();
      }}
      title="Run live eval"
      size="lg"
    >
      {run !== null ? (
        <RunView
          projectId={projectId}
          run={run}
          onClose={() => {
            setRunId(null);
            onClose();
          }}
        />
      ) : preview.data ? (
        <Confirm
          projectId={projectId}
          suiteKey={suiteKey}
          preview={preview.data}
          onStarted={(started) => {
            setRunId(started.id);
          }}
        />
      ) : (
        <Loader size="sm" />
      )}
    </Modal>
  );
}

function History({
  projectId,
  runs,
}: {
  readonly projectId: ProjectId;
  readonly runs: readonly EvalLiveRunDto[];
}) {
  const stop = useStopEvalLive(projectId);
  if (runs.length === 0) return null;
  return (
    <Stack gap={2} data-testid="live-runs">
      {runs.map((r) => (
        <Group key={r.id} gap="xs" wrap="nowrap" align="baseline">
          <Text size="xs" c="dimmed">
            {dayTimeText(r.startedAt)}
          </Text>
          <Text size="xs">
            {runWords(r)}
            {r.state === EvalLiveRunState.Running ? (
              <>
                {' · '}
                <Elapsed startedAt={r.startedAt} />
              </>
            ) : null}
            {r.state === EvalLiveRunState.Interrupted && !r.stopRan
              ? '; the work in your containers may still be running'
              : ''}
          </Text>
          {r.state === EvalLiveRunState.Running ? (
            <Button
              size="compact-xs"
              color="red"
              variant="light"
              onClick={() => {
                stop.mutate(r.id);
              }}
            >
              Stop
            </Button>
          ) : null}
        </Group>
      ))}
    </Stack>
  );
}

/**
 * A suite's Run beside its live command: the confirm window, and its last five runs with Stop on a running one.
 * A suite whose assessment recorded no `live` settings has no Run, and says how to get one.
 */
export function LiveRunControls({
  projectId,
  suiteKey,
  label = 'Run',
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly label?: string;
}) {
  const preview = useEvalLivePreview(projectId, suiteKey, true);
  const runs = useEvalLiveRuns(projectId, suiteKey);
  const [opened, setOpened] = useState(false);
  const clipboard = useClipboard({ timeout: 1500 });
  if (preview.data?.refusal === EvalLiveRefusal.NoLive) {
    return (
      <Stack gap={4} align="flex-start">
        <Text size="xs" c="dimmed">
          {REFUSAL_WORDS[EvalLiveRefusal.NoLive]}
        </Text>
        <Button
          size="compact-xs"
          variant="default"
          leftSection={<IconCopy size={14} stroke={1.5} />}
          onClick={() => {
            clipboard.copy(
              `Use the 10db-task skill to assess the evals of the 10db project ${projectId}, and record how the live command of ${suiteKey} runs.`,
            );
          }}
        >
          {clipboard.copied ? 'Copied' : 'Copy the Ask'}
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap="xs" align="flex-start">
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => {
          setOpened(true);
        }}
      >
        {label}
      </Button>
      <History projectId={projectId} runs={runs.data ?? []} />
      <RunModal
        projectId={projectId}
        suiteKey={suiteKey}
        opened={opened}
        onClose={() => {
          setOpened(false);
        }}
      />
    </Stack>
  );
}
