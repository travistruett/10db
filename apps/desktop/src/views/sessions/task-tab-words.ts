import {
  BoardStatus,
  WorkstreamState,
  type TaskSessionDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { failureLine } from '../board/task-state';

// Sessions UI §8.5: what a separate copy's tab says of its run, as one line after the thread.

export type CopyFooter =
  | { readonly kind: 'running' }
  | { readonly kind: 'waiting'; readonly text: string }
  | {
      readonly kind: 'in_review';
      readonly text: string;
      readonly pullRequest: string | null;
    }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

/** The pull request's number from its address, or null when it names none. */
export function pullRequestNumber(url: string): string | null {
  return /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? null;
}

/**
 * The line under a copy's thread. A failed run says what happened in the Board's words; a finished one
 * names its pull request; a running one has the composer.
 */
export function copyFooter(
  session: Pick<TaskSessionDto, 'board' | 'pullRequest'>,
  workstream: WorkstreamDto | undefined,
): CopyFooter {
  if (workstream?.state === WorkstreamState.Failed)
    return { kind: 'failed', text: failureLine(workstream, false) };
  switch (session.board) {
    case BoardStatus.Done:
      return { kind: 'done', text: 'Done · merged.' };
    case BoardStatus.InReview: {
      const number =
        session.pullRequest === null ? null : pullRequestNumber(session.pullRequest.url);
      const checks = session.pullRequest?.state ?? null;
      return {
        kind: 'in_review',
        text:
          number === null
            ? 'Finished · in review'
            : `Finished · in review: pull request #${number}${checks === null ? '' : ` · ${checks}`}`,
        pullRequest: session.pullRequest?.url ?? null,
      };
    }
    case BoardStatus.InProgress:
      return { kind: 'running' };
    case BoardStatus.Blocked:
      return { kind: 'waiting', text: 'Waiting on you: open this task on the Board.' };
    case BoardStatus.Backlog:
    case BoardStatus.Ready:
      return { kind: 'waiting', text: 'Queued · it starts when a lane is free.' };
  }
}

/**
 * What a pass of one's tab says once its pass is no longer live, by where the task stands: finished,
 * or abandoned (its unfinished changes wait on the Board). A task still running has a pass the live
 * list has not shown yet, so it says nothing and the tab keeps loading.
 */
export function passGoneLine(board: BoardStatus): string | null {
  switch (board) {
    case BoardStatus.Done:
      return 'Done · this task’s pass has finished.';
    case BoardStatus.InReview:
      return 'Finished · in review: its pull request has the changes.';
    case BoardStatus.InProgress:
      return null;
    case BoardStatus.Blocked:
    case BoardStatus.Backlog:
    case BoardStatus.Ready:
      return 'Abandoned · its unfinished changes wait on this task on the Board.';
  }
}
