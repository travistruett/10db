import { CARD_RESOLUTION, InboxState, mintId } from '@10db/contracts';
import { createTestStore, getInboxItem, seedProject, type OpenFlagRow } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { CardTier, createInboxService, flagCard, BY_ANSWER } from '../inbox';
import { NOTICE_SWEEP_REASON, noticeTypeOf, resolveNoticeCards } from './notice-sweep';

const card = (over: Partial<Omit<OpenFlagRow, 'id'>>): OpenFlagRow => ({
  id: mintId('InboxItem'),
  foldKey: null,
  title: 'A title',
  body: 'A body.',
  optionCount: 1,
  ...over,
});

describe('noticeTypeOf', () => {
  const rows: readonly [string, Partial<Omit<OpenFlagRow, 'id'>>, string | null][] = [
    ['branch-deleted', { foldKey: 'branch-deleted:bat_1' }, 'branch-deleted'],
    [
      'orphan-not-removed',
      { foldKey: 'worktree-remove-failed:/w', title: '10db removed nothing at /w' },
      'orphan-not-removed',
    ],
    ['tasks-moved', { title: '2 tasks moved off feat/x, which no longer exists' }, 'tasks-moved'],
    ['one task moved', { title: '1 task moved off feat/x, which no longer exists' }, 'tasks-moved'],
    [
      'regenerate-failed',
      {
        foldKey: 'base-regenerate:bat_1',
        title: 'Batch "B": 10db couldn\'t regenerate files after merging main',
      },
      'regenerate-failed',
    ],
    ['pass-follow-on', { foldKey: 'pass-follow-on:pas_1' }, 'pass-follow-on'],
    ['pass-gate', { foldKey: 'pass-gate:pas_1' }, 'pass-gate'],
    ['pass-branch-moved', { foldKey: 'pass-branch-moved:pas_1' }, 'pass-branch-moved'],
    ['pass-abandoned', { foldKey: 'pass-abandon:pas_1', optionCount: 0 }, 'pass-abandoned'],
    [
      'model-retried',
      { foldKey: 'model-refused:acc:m', body: 'It refused, and is running the step on gpt-5.' },
      'model-retried',
    ],
    ['left-changes', { title: 'The review step left changes in its claims' }, 'left-changes'],
    ['no-handoff', { title: 'Session ended without the requested handoff' }, 'no-handoff'],
    ['resized', { foldKey: 'resize:tsk_1' }, 'resized'],
    ['pass-did-not-open', { title: 'Pass ‘Nav’ did not open' }, 'pass-did-not-open'],
    ['pass-cancelled', { title: 'Pass ‘Nav’ was cancelled for 10db’s update' }, 'pass-cancelled'],
    ['hand-made-removed', { foldKey: 'hand-made-removed:/w' }, 'hand-made-removed'],
    [
      'hand-made-spotlight-done',
      { foldKey: 'hand-made-spotlight-done:/w' },
      'hand-made-spotlight-done',
    ],
    // Near misses: asks that share a prefix or a title shape.
    [
      'remove failed ask',
      { foldKey: 'worktree-remove-failed:/w', title: '10db could not remove /w' },
      null,
    ],
    [
      'lost migrations ask',
      {
        foldKey: 'base-regenerate:bat_1',
        title: 'Batch "B" lost migrations 10db can no longer list',
      },
      null,
    ],
    ['abandon with a move', { foldKey: 'pass-abandon:pas_1', optionCount: 1 }, null],
    [
      'model with nothing left',
      { foldKey: 'model-refused:acc:m', body: 'It has nothing left to run the step on.' },
      null,
    ],
    [
      'model stopped the task',
      { foldKey: 'model-refused:acc:m', body: 'It refused, so 10db stopped the task.' },
      null,
    ],
    ['checkout-return', { foldKey: 'checkout-return:bat_1' }, null],
    ['pass-folder', { foldKey: 'pass-folder:pas_1' }, null],
    [
      'left changes with a key',
      { foldKey: 'k:1', title: 'The review step left changes in its claims' },
      null,
    ],
    ['hand-made merged', { foldKey: 'hand-made:/w' }, null],
    ['hand-made-spotlight', { foldKey: 'hand-made-spotlight:/w' }, null],
    ['unrelated', { foldKey: 'something:1', title: 'Something' }, null],
  ];
  it.each(rows)('%s', (_name, over, expected) => {
    expect(noticeTypeOf(card(over))).toBe(expected);
  });
});

describe('resolveNoticeCards', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    closers.splice(0).forEach((close) => {
      close();
    });
  });

  it('resolves open notice-type cards once, leaving asks and closed cards alone', () => {
    const test = createTestStore();
    closers.push(test.close);
    const state = createStateStore(test.store, createEventBus());
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
    const project = seedProject(test.store);
    const raise = (title: string, foldKey: string) =>
      state.write((ctx) =>
        flagCard(ctx, {
          projectId: project.id,
          tier: CardTier.Status,
          urgency: 'normal',
          closesWhen: BY_ANSWER,
          workstreamId: null,
          title,
          body: 'Body.',
          foldKey,
          options: [{ label: 'Got it', description: '' }],
        }),
      );
    const notices = [
      raise('Pass ‘A’ closed', 'pass-gate:pas_1'),
      raise('B', 'branch-deleted:bat_1'),
      raise('C', 'resize:tsk_1'),
    ];
    const ask = raise('Ask', 'checkout-return:bat_1');
    const dismissed = raise('D', 'pass-gate:pas_2');
    inbox.answer(dismissed.id, { choice: 'Got it' });
    const dismissedState = getInboxItem(state.db, dismissed.id).state;

    expect(resolveNoticeCards(state.db, inbox)).toBe(3);
    for (const item of notices) {
      const after = getInboxItem(state.db, item.id);
      expect(after.state).toBe(InboxState.Resolved);
      expect(after.detail?.[CARD_RESOLUTION]).toMatchObject({ reason: NOTICE_SWEEP_REASON });
    }
    expect(getInboxItem(state.db, ask.id).state).toBe(InboxState.Open);
    expect(dismissedState).not.toBe(InboxState.Open);
    expect(getInboxItem(state.db, dismissed.id).state).toBe(dismissedState);
    expect(resolveNoticeCards(state.db, inbox)).toBe(0);
  });
});
