import { InboxKind, type InboxItemDto, type ProjectId, type WorkstreamDto } from '@10db/contracts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useCloseTask, useRetryWorkstream } from '../../daemon/queries';
import { ProjectTile } from '../../shell/project-tile';
import { failureLine } from '../board/task-state';
import { joinNames } from '../inbox/route-line';
import type { FailureCause } from './factory-summary';
import { lastMoment } from './live-groups';
import { shortAgo } from './short-ago';
import { FailureDot } from './failure-card';
import { failedAt, TaskLine } from './task-line';

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

/** A question or a plan to approve reads yellow; any other kind of card is gray. */
const YELLOW_KINDS: ReadonlySet<InboxKind> = new Set([InboxKind.Question, InboxKind.Plan]);

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
  /** Runs waiting on a question someone other than the builder holds, with the card that asks it. */
  readonly others: readonly WaitingRun[];
  readonly now: number;
  readonly nameOf: (id: ProjectId) => string;
  readonly canRetry: (ws: WorkstreamDto) => boolean;
  readonly canClose: (ws: WorkstreamDto) => boolean;
  readonly onOpen: (ws: WorkstreamDto) => void;
  readonly onOpenInbox: (projectId: ProjectId) => void;
  readonly onOpenPass: (projectId: ProjectId) => void;
}

const KindColor = { You: 'yellow', Failed: 'red', Other: 'gray' } as const;
type KindColor = (typeof KindColor)[keyof typeof KindColor];

/**
 * One row of the panel: what kind of ask as a badge, which is the row's mark, then its title over one dim
 * line, the project, when, and the actions. Every title starts at the same edge.
 */
function Need({
  kind,
  color,
  avatar,
  title,
  sub,
  subTip,
  project,
  when,
  children,
}: {
  readonly kind: string;
  readonly color: KindColor;
  /** A person's avatar inside the badge, for a question out with them. */
  readonly avatar?: string | undefined;
  readonly title: string;
  readonly sub: string;
  /** The dim line's tooltip, such as what a failure means and what Retry does. */
  readonly subTip?: string | undefined;
  readonly project: string;
  readonly when: string;
  readonly children: ReactNode;
}) {
  return (
    <Table.Tr>
      <Table.Td w={120} style={{ verticalAlign: 'top' }}>
        <Badge
          size="xs"
          variant="light"
          color={color}
          maw="100%"
          mt={3}
          // A person's name keeps its own case.
          tt={avatar === undefined ? undefined : 'none'}
          leftSection={
            avatar === undefined ? undefined : (
              <Avatar size={12} radius="xl" color="gray" name={avatar} />
            )
          }
        >
          {kind}
        </Badge>
      </Table.Td>
      <Table.Td style={{ maxWidth: 0 }}>
        <Text size="sm" fw={500} c="bright" truncate>
          {title}
        </Text>
        <Tooltip label={subTip} disabled={subTip === undefined} multiline maw={420} withArrow>
          <Text size="xs" c="dimmed" truncate mt={2}>
            {sub}
          </Text>
        </Tooltip>
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
      <Table.Td w={200}>
        <Group gap={6} justify="flex-end" wrap="nowrap">
          {children}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** The agent's own reason, cut to its first sentence. */
function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return match === null ? text.trim() : match[0];
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
  closing,
  onClose,
}: {
  readonly cause: FailureCause;
  readonly props: NeedsYouProps;
  readonly retrying: boolean;
  readonly onRetry: (runs: readonly WorkstreamDto[]) => void;
  readonly closing: boolean;
  readonly onClose: (run: WorkstreamDto) => void;
}) {
  const [shown, setShown] = useState(false);
  const [first] = cause.runs;
  if (first === undefined) return null;
  const retryable = cause.runs.filter(props.canRetry);
  const project = props.nameOf(cause.projectId);
  const when = shortAgo(lastMoment(first), props.now);
  if (cause.runs.length === 1) {
    const line = failureLine(first, retryable.length > 0);
    return (
      <Need
        kind="Failed"
        color={KindColor.Failed}
        title={first.taskTitle}
        sub={first.failureReason === null ? line : firstSentence(first.failureReason)}
        subTip={first.failureReason === null ? undefined : line}
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
        {props.canClose(first) ? (
          <Button
            size="compact-xs"
            variant="default"
            loading={closing}
            onClick={() => {
              onClose(first);
            }}
          >
            Close
          </Button>
        ) : null}
      </Need>
    );
  }
  return (
    <>
      <Need
        kind={`${String(cause.runs.length)} tasks`}
        color={KindColor.Failed}
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
          <Table.Td colSpan={4} pt={0}>
            <Stack gap={0} role="group" aria-label={`${String(cause.runs.length)} failed tasks`}>
              {cause.runs.map((run) => (
                <TaskLine
                  key={run.id}
                  mark={
                    <FailureDot
                      run={run}
                      canRetry={props.canRetry(run)}
                      canClose={props.canClose(run)}
                      onOpen={() => {
                        props.onOpen(run);
                      }}
                    />
                  }
                  title={run.taskTitle}
                  detail={
                    run.failureReason === null ? failedAt(run) : firstSentence(run.failureReason)
                  }
                  when={shortAgo(lastMoment(run), props.now)}
                  compact
                  action={
                    <>
                      {props.canRetry(run) ? (
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
                      ) : null}
                      {props.canClose(run) ? (
                        <Button
                          size="compact-xs"
                          variant="default"
                          loading={closing}
                          onClick={() => {
                            onClose(run);
                          }}
                        >
                          Close
                        </Button>
                      ) : null}
                    </>
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

/**
 * What needs the builder, across projects: runs waiting on their answer, Workbench pages waiting on them, and
 * failed runs grouped by what stopped them. Under it, apart and unlit, each question out with someone else,
 * named by its person and its own words. Draws nothing while neither has anything.
 */
export function NeedsYouPanel(props: NeedsYouProps) {
  const retry = useRetryWorkstream();
  const closeTask = useCloseTask();
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const { waiting, passes, causes, others, now, nameOf } = props;
  const failed = causes.reduce((n, c) => n + c.runs.length, 0);
  const asks = waiting.length + passes.length;
  if (asks + failed + others.length === 0) return null;

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
    <Stack component="section" aria-label="Needs you and waiting on others" gap={12}>
      {asks + failed > 0 ? (
        <Group gap={8} align="baseline">
          <Title order={2} fz={14} fw={600} c="bright">
            Needs you
          </Title>
          <Text size="xs" c="dimmed">
            {meta}
          </Text>
        </Group>
      ) : null}
      {closeTask.error === null ? null : (
        <Alert
          color="red"
          title="Couldn't close the task"
          withCloseButton
          onClose={() => {
            closeTask.reset();
          }}
        >
          {closeTask.error.message}
        </Alert>
      )}
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
        <Paper variant="raised" radius="md">
          <Table verticalSpacing={14} horizontalSpacing="md" layout="fixed">
            <Table.Tbody>
              {waiting.map(({ run, card }) => (
                <Need
                  key={run.id}
                  kind={card === undefined ? 'Waiting on you' : KIND_LABELS[card.kind]}
                  color={
                    card === undefined || YELLOW_KINDS.has(card.kind)
                      ? KindColor.You
                      : KindColor.Other
                  }
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
                  kind="UI Workbench"
                  color={KindColor.Other}
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
                    closeTask.reset();
                    void retryAll(cause.key, runs);
                  }}
                  closing={
                    closeTask.isPending && cause.runs.some((r) => r.taskId === closeTask.variables)
                  }
                  onClose={(run) => {
                    retry.reset();
                    closeTask.mutate(run.taskId);
                  }}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      ) : null}
      {others.length === 0 ? null : (
        <Stack gap={12} mt={asks + failed > 0 ? 'lg' : 0}>
          <Group gap={8} align="baseline">
            <Title order={2} fz={14} fw={600} c="bright">
              Waiting on others
            </Title>
            <Text size="xs" c="dimmed">
              nothing for you to do until they answer
            </Text>
          </Group>
          <Paper radius="md" px="xs" withBorder bg="transparent">
            <Table verticalSpacing={14} horizontalSpacing="md" layout="fixed">
              <Table.Tbody>
                {others.map(({ run, card }) => {
                  const names = run.waitingOn?.names ?? [];
                  return (
                    <Need
                      key={run.id}
                      avatar={names[0] ?? '?'}
                      kind={joinNames(names)}
                      color={KindColor.Other}
                      title={card?.title ?? 'A question about this task'}
                      sub={run.taskTitle}
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
                    </Need>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Paper>
        </Stack>
      )}
    </Stack>
  );
}
