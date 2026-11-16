import { BoardStatus } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { PageStatus } from '../workbench/page-status';
import { tabWords, TabState } from './tab-state';
import { taskTabState, type TaskTabFacts } from './task-tab-state';

const NONE: TaskTabFacts = { board: null, failed: false, page: null, passClosed: false };

describe('taskTabState', () => {
  it.each<{
    readonly name: string;
    readonly facts: Partial<TaskTabFacts>;
    readonly want: TabState;
  }>([
    { name: 'nothing read yet', facts: {}, want: TabState.Idle },
    { name: 'a run in progress', facts: { board: BoardStatus.InProgress }, want: TabState.Working },
    {
      name: 'a failed run',
      facts: { board: BoardStatus.InProgress, failed: true },
      want: TabState.Error,
    },
    {
      name: 'a failed run on a blocked task',
      facts: { board: BoardStatus.Blocked, failed: true },
      want: TabState.Error,
    },
    {
      name: 'a blocked task waits on the builder',
      facts: { board: BoardStatus.Blocked },
      want: TabState.NeedsYou,
    },
    { name: 'a page that asks', facts: { page: PageStatus.Asks }, want: TabState.NeedsYou },
    { name: 'a page that failed', facts: { page: PageStatus.Failed }, want: TabState.Error },
    {
      name: 'a page whose preview broke',
      facts: { page: PageStatus.PreviewBroken },
      want: TabState.Error,
    },
    { name: 'a ready page', facts: { page: PageStatus.Ready }, want: TabState.Ready },
    { name: 'a working page', facts: { page: PageStatus.Working }, want: TabState.Working },
    { name: 'a page signing off', facts: { page: PageStatus.SigningOff }, want: TabState.Working },
    { name: 'a paused page', facts: { page: PageStatus.Paused }, want: TabState.Paused },
    {
      name: 'a signed-off page of an open pass',
      facts: { page: PageStatus.SignedOff },
      want: TabState.SignedOff,
    },
    {
      name: 'a signed-off page of a closed pass',
      facts: { page: PageStatus.SignedOff, passClosed: true },
      want: TabState.InReview,
    },
    {
      name: 'a pull request open',
      facts: { board: BoardStatus.InReview },
      want: TabState.InReview,
    },
    { name: 'merged work', facts: { board: BoardStatus.Done }, want: TabState.Done },
    { name: 'a queued task', facts: { board: BoardStatus.Ready }, want: TabState.Idle },
  ])('$name is $want', ({ facts, want }) => {
    expect(taskTabState({ ...NONE, ...facts })).toBe(want);
  });
});

describe('a task tab’s look (UI spec §5.3)', () => {
  it.each([
    { state: TabState.NeedsYou, mark: 'dot_yellow', ring: 'yellow' },
    { state: TabState.Ready, mark: 'dot_yellow', ring: 'yellow' },
    { state: TabState.Error, mark: 'alert_red', ring: 'red' },
    { state: TabState.InReview, mark: 'review_dim', ring: null },
    { state: TabState.SignedOff, mark: 'check_dim', ring: null },
    { state: TabState.Done, mark: 'check_green', ring: null },
  ] as const)('$state is a $mark with ring $ring', ({ state, mark, ring }) => {
    expect(tabWords(state)).toMatchObject({ mark, ring });
  });
});
