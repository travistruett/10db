import { BoardStatus } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { copyFooter, passGoneLine, pullRequestNumber } from './task-tab-words';

const pr = (state: string | null) => ({ url: 'https://github.com/a/b/pull/212', state });

describe('copyFooter', () => {
  it.each([
    {
      name: 'a run in progress takes messages',
      session: { board: BoardStatus.InProgress, pullRequest: null },
      want: { kind: 'running' },
    },
    {
      name: 'in review names its pull request and where CI stands',
      session: { board: BoardStatus.InReview, pullRequest: pr('CI running') },
      want: {
        kind: 'in_review',
        text: 'Finished · in review: pull request #212 · CI running',
        pullRequest: 'https://github.com/a/b/pull/212',
      },
    },
    {
      name: 'in review with no pull request address',
      session: { board: BoardStatus.InReview, pullRequest: null },
      want: { kind: 'in_review', text: 'Finished · in review', pullRequest: null },
    },
    {
      name: 'merged is done',
      session: { board: BoardStatus.Done, pullRequest: pr('merged') },
      want: { kind: 'done', text: 'Done · merged.' },
    },
  ])('$name', ({ session, want }) => {
    expect(copyFooter(session, undefined)).toEqual(want);
  });
});

describe('pullRequestNumber', () => {
  it.each([
    ['https://github.com/a/b/pull/212', '212'],
    ['https://github.com/a/b/pull/212/files', '212'],
    ['https://github.com/a/b', null],
  ])('%s is %s', (url, want) => {
    expect(pullRequestNumber(url)).toBe(want);
  });
});

describe('passGoneLine', () => {
  it.each([
    {
      name: 'a finished task',
      board: BoardStatus.Done,
      want: 'Done · this task’s pass has finished.',
    },
    {
      name: 'an in-review task',
      board: BoardStatus.InReview,
      want: 'Finished · in review: its pull request has the changes.',
    },
    {
      name: 'an abandoned pass, whose task waits on the Board',
      board: BoardStatus.Ready,
      want: 'Abandoned · its unfinished changes wait on this task on the Board.',
    },
    {
      name: 'a blocked task',
      board: BoardStatus.Blocked,
      want: 'Abandoned · its unfinished changes wait on this task on the Board.',
    },
    {
      name: 'a backlog task',
      board: BoardStatus.Backlog,
      want: 'Abandoned · its unfinished changes wait on this task on the Board.',
    },
    {
      name: 'a task still running, whose pass has not been read yet',
      board: BoardStatus.InProgress,
      want: null,
    },
  ])('says $name', ({ board, want }) => {
    expect(passGoneLine(board)).toBe(want);
  });
});
