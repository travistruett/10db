import {
  CardDecider,
  DecisionRule,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import type { WriteContext } from '@10db/db';
import { CardTier, postNotice } from '../inbox';

const SINCE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The key of a run's restart notice. */
export const restartNoticeKey = (id: WorkstreamId): string => `stall-restart:${id}`;

/**
 * Posts the notice of a restart, inside the write that requeued the run: the stopped session can't be
 * brought back, so the notice's undo is final. The time is a fixed one in the Mac's own, never a duration.
 */
export function postRestartNotice(
  w: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly workstreamId: WorkstreamId;
    readonly title: string;
    /** The state it stalled in. */
    readonly state: WorkstreamState;
    /** When it last showed activity. */
    readonly since: string;
    readonly fromHandoff: boolean;
  },
): void {
  postNotice(w, {
    tier: CardTier.Notice,
    projectId: input.projectId,
    taskId: input.taskId,
    key: restartNoticeKey(input.workstreamId),
    tone: 'info',
    line: `Restarted "${input.title}" after it showed no activity`,
    body: [
      `It was ${input.state.toLowerCase()} and had shown no activity since ${SINCE.format(new Date(input.since))}.`,
      input.fromHandoff
        ? 'It continues from its latest handoff.'
        : 'It starts the step again, as it had no handoff.',
      'Its claims and committed work are kept.',
    ].join(' '),
    decision: {
      by: CardDecider.Rule,
      rule: DecisionRule.StuckRun,
      confidence: null,
      undo: {
        state: 'final',
        reason: 'The stopped session can’t be brought back; cancel the run if you don’t want it.',
      },
    },
  });
}
