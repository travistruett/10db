import { WorkstreamState, type WorkstreamDto } from '@10db/contracts';
import { Box, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { ClippedText } from './clipped-text';
import classes from './factory-overview.module.css';
import { ModelBadge, StepProgress, stepLabel } from './stacked-bar';
import { StatusDot } from './status-dot';
import { STEP_LABEL } from './task-rows';

const S = WorkstreamState;

/** What a run is doing, in a few words after its title. */
export function doing(ws: WorkstreamDto): string {
  switch (ws.state) {
    case S.WaitingHuman:
      return ws.waitingOn === null
        ? 'Waiting on you'
        : `Question out with ${ws.waitingOn.names.join(', ')}`;
    case S.Failed:
      return ws.failureReason ?? 'Failed';
    case S.Queued:
      return ws.notice?.line ?? 'Waiting for a free lane';
    case S.Held:
      return 'Held, not in the queue';
    case S.PausedLimit:
      return 'Paused until the usage limit resets';
    case S.Recovering:
      return 'Recovering';
    case S.TakenOver:
      return 'In your terminal';
    case S.Done:
      return 'Done';
    case S.Cancelled:
      return 'Cancelled';
    case S.Starting:
    case S.Running:
    case S.HandingOff:
    case S.Verifying: {
      const step = ws.steps[ws.stepIndex];
      if (step === undefined) return ws.model;
      return `${step.role} ${String(ws.stepIndex + 1)}/${String(ws.steps.length)} · ${step.model}`;
    }
  }
}

/** A failed line's quiet detail: the step it stopped at. Its dot's hover card says the rest. */
export function failedAt(run: WorkstreamDto): string {
  const step = run.steps[run.stepIndex];
  return step === undefined ? 'Failed' : `Failed at ${STEP_LABEL[step.role]}`;
}

export const LineTone = { You: 'you', Plain: 'plain' } as const;
export type LineTone = (typeof LineTone)[keyof typeof LineTone];

/**
 * One task inside a project, on the card's shared columns: its mark, title, step segments, state (the step
 * in words while it runs), model and when. A line with no step under way has no segments or model, so its
 * state takes their columns. The line opens the task; the mark sits outside that button, so a
 * failure's hover card is its own target. Actions, where a line has them, sit after the columns.
 */
export function TaskLine({
  mark,
  title,
  run,
  detail,
  tone = LineTone.Plain,
  when,
  action,
  compact = false,
  onOpen,
}: {
  readonly mark: ReactNode;
  readonly title: string;
  /** Shows the step segments, step and model when the run is under way. */
  readonly run?: WorkstreamDto | undefined;
  readonly detail: string;
  readonly tone?: LineTone;
  readonly when: string;
  readonly action?: ReactNode;
  /** Outside a project card: no bar or model columns, so the title and state take the room. */
  readonly compact?: boolean;
  readonly onOpen: () => void;
}) {
  const running =
    run !== undefined &&
    (run.state === S.Running ||
      run.state === S.Starting ||
      run.state === S.Verifying ||
      run.state === S.HandingOff)
      ? run
      : undefined;
  const step = running?.steps[running.stepIndex];
  return (
    <div className={classes['line']}>
      <div className={classes['cols']} data-compact={compact || undefined}>
        <span className={classes['lineMark']}>{mark}</span>
        <UnstyledButton className={classes['lineOpen']} onClick={onOpen}>
          <ClippedText text={title} className={classes['lineTitle']} />
          {running === undefined || step === undefined ? null : (
            <span className={classes['lineProgress']}>
              <StepProgress run={running} />
            </span>
          )}
          <ClippedText
            text={running === undefined ? detail : (stepLabel(running) ?? detail)}
            c={tone === LineTone.You ? 'yellow' : 'dimmed'}
            className={classes['lineState']}
            wide={step === undefined}
          />
          {step === undefined ? null : (
            <span className={classes['lineModel']}>
              <ModelBadge model={step.model} />
            </span>
          )}
          <span className={classes['when']}>{when}</span>
        </UnstyledButton>
      </div>
      {action === undefined ? null : <span className={classes['lineAction']}>{action}</span>}
    </div>
  );
}

/**
 * A dot with a ring: waits on the builder. The ring's gap takes `--ring-gap`, the tone it sits on (the
 * page's body unless a panel sets it).
 */
export function WaitRing() {
  return (
    <Box
      component="span"
      aria-hidden
      w={7}
      h={7}
      mx={3}
      style={{
        flex: 'none',
        display: 'inline-block',
        borderRadius: '50%',
        background: 'var(--mantine-color-yellow-filled)',
        boxShadow:
          '0 0 0 2px var(--ring-gap, var(--mantine-color-body)), 0 0 0 3.5px var(--mantine-color-yellow-filled)',
      }}
    />
  );
}

/** The mark for a run's line: a ring waits on the builder, a dot runs, red failed, green merged, gray waits. */
export function RunMark({ color }: { readonly color: string }) {
  if (color === 'yellow') return <WaitRing />;
  return <StatusDot color={color} />;
}
