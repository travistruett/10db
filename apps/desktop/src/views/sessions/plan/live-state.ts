import {
  BoardStatus,
  TaskStatus,
  WorkstreamState,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';

/** A task's state in the words Factory's task list and the task drawer use, with its status color. */
export interface LiveWord {
  readonly word: string;
  readonly color: string;
}

const REMOVED: LiveWord = { word: 'Removed', color: 'gray' };

/** The word for one accepted task: gone from the Board, queued behind another run, or its column's. */
export function taskLiveWord(
  task: TaskDto | undefined,
  workstream: WorkstreamDto | undefined,
): LiveWord {
  if (task === undefined || task.status === TaskStatus.Cancelled) return REMOVED;
  if (workstream?.state === WorkstreamState.Queued) return { word: 'Queued', color: 'blue' };
  switch (task.boardStatus) {
    case BoardStatus.InProgress:
      return { word: 'Running', color: 'blue' };
    case BoardStatus.InReview:
      return { word: 'In Review', color: 'violet' };
    case BoardStatus.Blocked:
      return { word: 'Needs You', color: 'orange' };
    case BoardStatus.Done:
      return { word: 'Done', color: 'teal' };
    case BoardStatus.Ready:
      return { word: 'Ready', color: 'gray' };
    case BoardStatus.Backlog:
      return { word: 'Waiting', color: 'gray' };
  }
}

const COUNT_ORDER: readonly string[] = [
  'Running',
  'Queued',
  'Needs You',
  'In Review',
  'Ready',
  'Waiting',
  'Done',
  'Removed',
];

/** "2 running · 1 queued · 1 done"; a goal of one task says its word alone. */
export function goalLiveLine(words: readonly LiveWord[]): string {
  const [only] = words;
  if (words.length === 1 && only !== undefined) return only.word;
  return COUNT_ORDER.flatMap((word) => {
    const n = words.filter((w) => w.word === word).length;
    return n === 0 ? [] : [`${String(n)} ${word.toLowerCase()}`];
  }).join(' · ');
}
