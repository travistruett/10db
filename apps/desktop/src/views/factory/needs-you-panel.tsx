import { InboxKind, type InboxItemDto, type ProjectId, type WorkstreamDto } from '@10db/contracts';
import { Alert, Button, Stack } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useRetryWorkstream } from '../../daemon/queries';
import { ProjectTile } from '../../shell/project-tile';
import { failureLine } from '../board/task-state';
import { joinNames } from '../inbox/route-line';
import type { FailureCause } from './factory-summary';
import classes from './factory-overview.module.css';
import { lastMoment } from './live-groups';
import { shortAgo } from './short-ago';
import { StatusDot } from './status-dot';
import { LineTone, RunMark, TaskLine } from './task-line';

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
    <div className={classes['need']}>
      <span className={classes['needMark']}>{mark}</span>
      <div className={classes['needText']}>
        <div className={classes['needTitleLine']}>
          <span className={classes['needKind']} data-tone={tone}>
            {kind}
          </span>
          <span className={`${classes['needTitle'] ?? ''} ${classes['clip'] ?? ''}`}>{title}</span>
        </div>
        <span className={`${classes['needSub'] ?? ''} ${classes['clip'] ?? ''}`} title={subTitle}>
          {sub}
        </span>
      </div>
      <span className={classes['where']}>
        <ProjectTile name={project} size={14} />
        <span className={classes['clip']}>{project}</span>
      </span>
      <span className={classes['when']}>{when}</span>
      <span className={classes['actions']}>{children}</span>
    </div>
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
        <div
          className={classes['needRuns']}
          role="group"
          aria-label={`${String(cause.runs.length)} failed tasks`}
        >
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
        </div>
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
    <section aria-labelledby="factory-needs-you">
      <Stack gap={8}>
        <div className={classes['sectionHead']}>
          <span>
            <h2
              id="factory-needs-you"
              className={classes['sectionTitle']}
              style={{ display: 'inline' }}
            >
              Needs you
            </h2>
            {meta === '' ? null : <span className={classes['sectionMeta']}>{meta}</span>}
          </span>
        </div>
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
          <div className={classes['needs']}>
            {waiting.map(({ run, card }) => (
              <Need
                key={run.id}
                mark={<span className={classes['ring']} />}
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
                mark={<span className={classes['ring']} />}
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
          </div>
        ) : null}
        {others === null ? null : (
          <div className={classes['waitingLine']}>
            <IconClock size={14} stroke={1.5} aria-hidden />
            {others}
          </div>
        )}
      </Stack>
    </section>
  );
}
