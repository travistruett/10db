import { GoalStatus, type GoalDigestDto } from '@10db/contracts';
import { joinNames } from '../inbox/route-line';

/** What the builder can do about a goal now: one button, or nothing while the goal moves on its own. */
export const NextAction = {
  Start: 'start',
  Answer: 'answer',
  Retry: 'retry',
  Merge: 'merge',
} as const;
export type NextAction = (typeof NextAction)[keyof typeof NextAction];

export interface NextStep {
  /** One sentence on where the goal stands and what moves it. */
  readonly line: string;
  /** The same in a few words, for the list's column. */
  readonly short: string;
  readonly action: NextAction | null;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The goal's next step in words, from its status and how many of its tasks are ready to start: a draft
 * says how to begin, a waiting goal names who it waits on, and a moving one says what runs.
 */
export function nextStep(digest: GoalDigestDto, ready: number): NextStep {
  const { total, merged } = digest.progress;
  const cards = digest.waitingOn.recent.length + digest.waitingOn.earlier.length;
  switch (digest.status) {
    case GoalStatus.Failed:
      return {
        line: 'A task failed. Retry it, or close it to let the rest go on.',
        short: 'A task failed',
        action: 'retry',
      };
    case GoalStatus.WaitingOnYou:
      return {
        line: `${plural(cards, 'question')} for you hold${cards === 1 ? 's' : ''} this goal.`,
        short: `${plural(cards, 'question')} for you`,
        action: 'answer',
      };
    case GoalStatus.WaitingOnSomeone: {
      const names = [...new Set(digest.waitingOnSomeone.flatMap((c) => c.names))];
      return {
        line: `Waiting on ${joinNames(names)} to answer.`,
        short: `${joinNames(names)} to answer`,
        action: null,
      };
    }
    case GoalStatus.Paused:
      return {
        line: 'Paused. Nothing of it runs until you resume it.',
        short: 'Paused',
        action: null,
      };
    case GoalStatus.Running: {
      const now = digest.workingNow[0];
      const line =
        now === undefined
          ? 'Running.'
          : `Working on “${now.taskTitle}”, step ${String(now.stepNumber)} of ${String(now.stepCount)}.`;
      const short = `${plural(digest.workingNow.length, 'task')} running`;
      return ready > 0
        ? {
            line: `${line} ${plural(ready, 'more task')} could start.`,
            short: `${short}, ${String(ready)} ready`,
            action: 'start',
          }
        : { line, short, action: null };
    }
    case GoalStatus.Queued:
      return {
        line: 'Started, and waiting for a free lane.',
        short: 'Waiting for a lane',
        action: null,
      };
    case GoalStatus.Shipping:
      return {
        line: `Every task is done. ${plural(digest.openPullRequests, 'pull request')} to merge.`,
        short: `${plural(digest.openPullRequests, 'pull request')} to merge`,
        action: 'merge',
      };
    case GoalStatus.Idle:
      return ready > 0
        ? {
            line: `Nothing runs. ${plural(ready, 'task')} ready to start.`,
            short: `${String(ready)} ready to start`,
            action: 'start',
          }
        : { line: 'Nothing runs, and no task is ready.', short: 'Nothing ready', action: null };
    case GoalStatus.NotStarted:
      return ready === 0
        ? {
            line: `Nothing has run yet, and none of its ${plural(total, 'task')} is ready.`,
            short: 'Nothing ready',
            action: null,
          }
        : {
            line:
              ready === total
                ? `Nothing has run yet. All ${plural(total, 'task')} are ready.`
                : `Nothing has run yet. ${String(ready)} of ${plural(total, 'task')} are ready; the other ${String(total - ready)} wait on them.`,
            short: `${String(ready)} of ${String(total)} ready to start`,
            action: 'start',
          };
    case GoalStatus.Done:
      return {
        line: `Done. ${String(merged)} of ${plural(total, 'task')} merged.`,
        short: 'Every task merged',
        action: null,
      };
  }
}
