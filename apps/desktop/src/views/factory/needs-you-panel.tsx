import { InboxKind, type InboxItemDto, type ProjectId, type WorkstreamDto } from '@10db/contracts';
import { Alert, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useRetryWorkstream } from '../../daemon/queries';
import { ProjectTile } from '../../shell/project-tile';
import { failureLine } from '../board/task-state';
import { joinNames } from '../inbox/route-line';
import type { FailureCause } from './factory-summary';
import { lastMoment } from './live-groups';
import { shortAgo } from './short-ago';
import { StatusDot } from './status-dot';
import { LineTone, RunMark, TaskLine, WaitRing } from './task-line';

const KIND_LABELS: Readonly<Record<InboxKind, string>> = {
  [InboxKind.Question]: 'Question',
  [InboxKind.Permission]: 'Permission',
  [InboxKind.Proposal]: 'Proposal',
  [InboxKind.Review]: 'Review',
  [InboxKind.Flag]: 'Flag',
  [InboxKind.Check]: 'Check',
  [InboxKind.Plan]: 'Plan to approve',
  [InboxKind.PlaybookMoveReport]: 'Report',
  [InboxKind.Acceptance]: 'Acceptance',
};

/** A run waiting on the builder, with the Inbox card that asks, when there is one. */
export interface WaitingRun {
  readonly run: WorkstreamDto;
  readonly card: InboxItemDto | undefined;
}

/** A UI Workbench pass with pages waiting on the builder. */
export interface WaitingPass {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly pages: number;
}

export interface NeedsYouProps {
  readonly waiting: readonly WaitingRun[];
  readonly passes: readonly WaitingPass[];
  readonly causes: readonly FailureCause[];
  readonly onOthers: readonly WorkstreamDto[];
  readonly now: number;
  readonly nameOf: (id: ProjectId) => string;
  readonly canRetry: (ws: WorkstreamDto) => boolean;
  readonly onOpen: (ws: WorkstreamDto) => void;
  readonly onOpenInbox: (projectId: ProjectId) => void;
  readonly onOpenPass: (projectId: ProjectId) => void;
}

/** One row of the panel: its mark, what kind of ask and its title over one dim line, the project, when, actions. */
function Need({
  mark,
  kind,
  tone,
  title,
  sub,
  subTitle,
  project,
  when,
  children,
}: {
  readonly mark: ReactNode;
  readonly kind: string;
  readonly tone: 'you' | 'failed';
  readonly title: string;
  readonly sub: string;
  readonly subTitle?: string | undefined;
  readonly project: string;
  readonly when: string;
  readonly children: ReactNode;
}) {
  return (
    <Table.Tr>
      <Table.Td w={28} ta="center">
        {mark}
      </Table.Td>
      <Table.Td style={{ maxWidth: 0 }}>
        <Group gap={8} wrap="nowrap" align="baseline">
          <Text fz={11} fw={600} c={tone === 'you' ? 'yellow' : 'red'} style={{ flex: 'none' }}>
            {kind}
          </Text>
          <Text size="sm" fw={500} c="bright" truncate>
            {title}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" truncate title={subTitle}>
          {sub}
        </Text>
      </Table.Td>
      <Table.Td w={160}>
        <Group gap={6} wrap="nowrap">
          <ProjectTile name={project} size={14} />
          <Text size="xs" truncate>
            {project}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td w={84} ta="right">
        <Text
          size="xs"
          c="dimmed"
          style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {when}
        </Text>
      </Table.Td>
      <Table.Td w={170}>
        <Group gap={6} justify="flex-end" wrap="nowrap">
          {children}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function titlesOf(runs: readonly WorkstreamDto[]): string {
  const [a, b, ...rest] = runs.map((r) => r.taskTitle);
  const named = [a, b].filter((t) => t !== undefined).join(' · ');
  return rest.length === 0 ? named : `${named} · and ${String(rest.length)} more`;
}

/** One failure cause: a lone run reads as its task; several read as what happened, with Retry All. */
function Cause({
  cause,
  props,
  retrying,
  onRetry,
}: {
  readonly cause: FailureCause;
  readonly props: NeedsYouProps;
  readonly retrying: boolean;
  readonly onRetry: (runs: readonly WorkstreamDto[]) => void;
}) {
  const [shown, setShown] = useState(false);
  const [first] = cause.runs;
  if (first === undefined) return null;
  const retryable = cause.runs.filter(props.canRetry);
  const project = props.nameOf(cause.projectId);
  const when = shortAgo(lastMoment(first), props.now);
  const mark = <StatusDot color="red" />;
  if (cause.runs.length === 1) {
    return (
      <Need
        mark={mark}
        kind="Failed"
        tone="failed"
        title={first.taskTitle}
        sub={failureLine(first, retryable.length > 0)}
        subTitle={first.failureReason ?? undefined}
        project={project}
        when={when}
      >
        <Button
          size="compact-xs"
          variant="default"
          onClick={() => {
            props.onOpen(first);
          }}
        >
          Open
        </Button>
        {retryable.length > 0 ? (
          <Button
            size="compact-xs"
            variant="default"
            loading={retrying}
            onClick={() => {
              onRetry(retryable);
            }}
          >
            Retry
          </Button>
        ) : null}
      </Need>
    );
  }
  return (
    <>
      <Need
        mark={mark}
        kind={`${String(cause.runs.length)} tasks`}
        tone="failed"
        title={failureLine(first, false)}
        sub={titlesOf(cause.runs)}
        project={project}
        when={when}
      >
        <Button
          size="compact-xs"
          variant="default"
          aria-expanded={shown}
          onClick={() => {
            setShown(!shown);
          }}
        >
          {shown ? 'Hide' : 'Show'}
        </Button>
        {retryable.length > 0 ? (
          <Button
            size="compact-xs"
            variant="default"
            loading={retrying}
            onClick={() => {
              onRetry(retryable);
            }}
          >
            Retry All
          </Button>
        ) : null}
      </Need>
      {shown ? (
        <Table.Tr>
          <Table.Td />
          <Table.Td colSpan={4}>
            <Stack gap={0} role="group" aria-label={`${String(cause.runs.length)} failed tasks`}>
              {cause.runs.map((run) => (
                <TaskLine
                  key={run.id}
                  mark={<RunMark color="red" />}
                  title={run.taskTitle}
                  detail={run.failureReason ?? 'Failed'}
                  tone={LineTone.Failed}
                  when={shortAgo(lastMoment(run), props.now)}
                  action={
                    props.canRetry(run) ? (
                      <Button
                        size="compact-xs"
                        variant="default"
                        loading={retrying}
                        onClick={() => {
                          onRetry([run]);
                        }}
                      >
                        Retry
                      </Button>
                    ) : undefined
                  }
                  onOpen={() => {
                    props.onOpen(run);
                  }}
                />
              ))}
            </Stack>
          </Table.Td>
        </Table.Tr>
      ) : null}
    </>
  );
}

/** "Waiting on Mark Ellis: 2 questions, the oldest 3h ago": what the builder waits on someone else for. */
function othersLine(runs: readonly WorkstreamDto[], now: number): string | null {
  const names = [...new Set(runs.flatMap((r) => r.waitingOn?.names ?? []))];
  const oldest = runs.map(lastMoment).sort()[0];
  if (names.length === 0 || oldest === undefined) return null;
  const n = runs.length;
  return `Waiting on ${joinNames(names)}: ${String(n)} ${n === 1 ? 'question' : 'questions'}, the oldest ${shortAgo(oldest, now)}`;
}

/**
 * What needs the builder, across projects: runs waiting on their answer, Workbench pages waiting on them, and
 * failed runs grouped by what stopped them. Under it, one dim line for what waits on someone else. Draws
 * nothing while nothing needs the builder and nobody else holds a question.
 */
export function NeedsYouPanel(props: NeedsYouProps) {
  const retry = useRetryWorkstream();
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const { waiting, passes, causes, onOthers, now, nameOf } = props;
  const failed = causes.reduce((n, c) => n + c.runs.length, 0);
  const asks = waiting.length + passes.length;
  const others = othersLine(onOthers, now);
  if (asks + failed === 0 && others === null) return null;

  async function retryAll(key: string, runs: readonly WorkstreamDto[]): Promise<void> {
    setRetryingKey(key);
    try {
      for (const run of runs) await retry.mutateAsync({ id: run.id });
    } catch {
      // The mutation keeps its error, which the alert above the rows shows.
    } finally {
      setRetryingKey(null);
    }
  }

  const meta = [
    asks > 0 ? `${String(asks)} to answer` : null,
    failed > 0
      ? `${String(failed)} failed, in ${String(causes.length)} ${causes.length === 1 ? 'cause' : 'causes'}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <Stack component="section" aria-labelledby="factory-needs-you" gap={8}>
      <Group gap={8} align="baseline">
        <Title id="factory-needs-you" order={2} fz={14} fw={600} c="bright">
          Needs you
        </Title>
        {meta === '' ? null : (
          <Text size="xs" c="dimmed">
            {meta}
          </Text>
        )}
      </Group>
      {retry.error === null ? null : (
        <Alert
          color="red"
          title="Couldn't retry the run"
          withCloseButton
          onClose={() => {
            retry.reset();
          }}
        >
          {retry.error.message}
        </Alert>
      )}
      {asks + failed > 0 ? (
        <Paper
          radius="md"
          bg="var(--tendb-color-panel)"
          style={{ '--ring-gap': 'var(--tendb-color-panel)' }}
        >
          <Table verticalSpacing={10} horizontalSpacing={10} layout="fixed">
            <Table.Tbody>
              {waiting.map(({ run, card }) => (
                <Need
                  key={run.id}
                  mark={<WaitRing />}
                  kind={card === undefined ? 'Waiting on you' : KIND_LABELS[card.kind]}
                  tone="you"
                  title={card?.title ?? run.taskTitle}
                  sub={card === undefined ? 'Open the task to see what it asks' : run.taskTitle}
                  project={nameOf(run.projectId)}
                  when={shortAgo(lastMoment(run), now)}
                >
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() => {
                      props.onOpen(run);
                    }}
                  >
                    Open
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() => {
                      props.onOpenInbox(run.projectId);
                    }}
                  >
                    Answer
                  </Button>
                </Need>
              ))}
              {passes.map((pass) => (
                <Need
                  key={pass.key}
                  mark={<WaitRing />}
                  kind="UI Workbench"
                  tone="you"
                  title={pass.title}
                  sub={`${String(pass.pages)} ${pass.pages === 1 ? 'page' : 'pages'} waiting on you`}
                  project={nameOf(pass.projectId)}
                  when=""
                >
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() => {
                      props.onOpenPass(pass.projectId);
                    }}
                  >
                    Open Pass
                  </Button>
                </Need>
              ))}
              {causes.map((cause) => (
                <Cause
                  key={cause.key}
                  cause={cause}
                  props={props}
                  retrying={retryingKey === cause.key}
                  onRetry={(runs) => {
                    void retryAll(cause.key, runs);
                  }}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      ) : null}
      {others === null ? null : (
        <Group gap={8} px={14} wrap="nowrap">
          <IconClock size={14} stroke={1.5} color="var(--mantine-color-dimmed)" aria-hidden />
          <Text size="xs" c="dimmed">
            {others}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
