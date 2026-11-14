import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { focusTarget, NOTIFIED_FOCUS_MS, type FocusInput } from './focus-target';
import { PageStatus } from './page-status';

const NOW = 1_000_000;
const [asks, ready, working, signedOff, other] = Array.from({ length: 5 }, () => mintId('Task'));
const id = (task: TaskId | undefined): TaskId => task ?? mintId('Task');

/** The queue in order: a question, a Ready page, then the dimmed pages. */
const rows = [
  { taskId: id(asks), status: PageStatus.Asks },
  { taskId: id(ready), status: PageStatus.Ready },
  { taskId: id(working), status: PageStatus.Working },
  { taskId: id(signedOff), status: PageStatus.SignedOff },
];

function input(overrides: Partial<FocusInput>): FocusInput {
  return { now: NOW, notified: [], rows, selected: id(working), drafts: new Set(), ...overrides };
}

const shown = (taskId: TaskId | undefined, secondsAgo: number, acted = false) => ({
  taskId: id(taskId),
  at: NOW - secondsAgo * 1000,
  acted,
});

describe('focusTarget', () => {
  it.each<{ name: string; input: FocusInput; target: TaskId | null }>([
    {
      name: 'a ready notification shown 3 s ago selects its page',
      input: input({ notified: [shown(ready, 3)] }),
      target: id(ready),
    },
    {
      name: 'of two shown in the window, the later one wins: it is the one on screen',
      input: input({ notified: [shown(working, 2), shown(ready, 8)] }),
      target: id(working),
    },
    {
      name: 'a notification older than 10 s falls back to the queue',
      input: input({ notified: [shown(ready, NOTIFIED_FOCUS_MS / 1000 + 1)] }),
      target: id(asks),
    },
    {
      name: 'a notification already acted on falls back to the queue',
      input: input({ notified: [shown(ready, 3, true)] }),
      target: id(asks),
    },
    {
      name: 'a notification for a page no longer in the pass falls back to the queue',
      input: input({ notified: [shown(other, 3)] }),
      target: id(asks),
    },
    {
      name: 'a notification never takes the builder from a draft',
      input: input({ notified: [shown(ready, 3)], drafts: new Set([id(working)]) }),
      target: null,
    },
    {
      name: 'focus by other means selects the oldest page that waits',
      input: input({}),
      target: id(asks),
    },
    {
      name: 'nothing moves while the selected page waits on the builder',
      input: input({ selected: id(ready) }),
      target: null,
    },
    {
      name: 'nothing moves while the selected page holds a draft',
      input: input({ drafts: new Set([id(working)]) }),
      target: null,
    },
    {
      name: 'a draft on another page does not hold the selection',
      input: input({ drafts: new Set([id(ready)]) }),
      target: id(asks),
    },
    {
      name: 'with nothing selected, the oldest page that waits',
      input: input({ selected: null }),
      target: id(asks),
    },
    {
      name: 'nothing moves when no page waits',
      input: input({ rows: rows.slice(2) }),
      target: null,
    },
  ])('$name', ({ input: given, target }) => {
    expect(focusTarget(given)).toBe(target);
  });
});
