import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { PageStatus } from './page-status';
import {
  nextWaiting,
  stepIndex,
  WorkbenchKey,
  workbenchKey,
  type KeyPress,
} from './workbench-keys';

const press = (key: string, mods: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const on = { editing: false, ignored: false, dialog: false };

describe('workbenchKey', () => {
  it.each<{ name: string; press: KeyPress; where?: Partial<typeof on>; key: WorkbenchKey | null }>([
    { name: 'J moves down', press: press('j'), key: WorkbenchKey.Next },
    { name: 'K moves up', press: press('k'), key: WorkbenchKey.Previous },
    {
      name: 'N goes to the next page that waits',
      press: press('n'),
      key: WorkbenchKey.NextWaiting,
    },
    {
      name: '⌘L copies the link',
      press: press('l', { metaKey: true }),
      key: WorkbenchKey.CopyLink,
    },
    {
      name: 'Ctrl-L copies off a Mac',
      press: press('l', { ctrlKey: true }),
      key: WorkbenchKey.CopyLink,
    },
    {
      name: '⌘L copies from the composer too: it types nothing',
      press: press('l', { metaKey: true }),
      where: { editing: true },
      key: WorkbenchKey.CopyLink,
    },
    {
      name: 'J typed into a message is text',
      press: press('j'),
      where: { editing: true },
      key: null,
    },
    {
      name: 'N typed into a message is text',
      press: press('n'),
      where: { editing: true },
      key: null,
    },
    {
      name: 'a region that keeps its keys',
      press: press('j'),
      where: { ignored: true },
      key: null,
    },
    {
      name: '⌘L inside a region that keeps its keys',
      press: press('l', { metaKey: true }),
      where: { ignored: true },
      key: null,
    },
    { name: 'a dialog on top', press: press('k'), where: { dialog: true }, key: null },
    { name: 'shift-J is not J', press: press('J', { shiftKey: true }), key: null },
    { name: '⌘J is not J', press: press('j', { metaKey: true }), key: null },
    { name: '⌘⇧L is not ⌘L', press: press('L', { metaKey: true, shiftKey: true }), key: null },
    { name: 'another letter', press: press('x'), key: null },
  ])('$name', ({ press: p, where, key }) => {
    expect(workbenchKey(p, { ...on, ...where })).toBe(key);
  });
});

describe('stepIndex', () => {
  it.each<{ name: string; from: number | null; delta: 1 | -1; count: number; to: number | null }>([
    { name: 'down one', from: 1, delta: 1, count: 4, to: 2 },
    { name: 'up one', from: 1, delta: -1, count: 4, to: 0 },
    { name: 'stays at the foot', from: 3, delta: 1, count: 4, to: 3 },
    { name: 'stays at the top', from: 0, delta: -1, count: 4, to: 0 },
    { name: 'from nowhere, down is the first', from: null, delta: 1, count: 4, to: 0 },
    { name: 'an empty queue goes nowhere', from: null, delta: 1, count: 0, to: null },
  ])('$name', ({ from, delta, count, to }) => {
    expect(stepIndex(from, delta, count)).toBe(to);
  });
});

describe('nextWaiting', () => {
  const ids = Array.from({ length: 5 }, () => mintId('Task'));
  const at = (i: number): TaskId => ids[i] ?? mintId('Task');
  const rows = [
    { taskId: at(0), status: PageStatus.Asks },
    { taskId: at(1), status: PageStatus.Failed },
    { taskId: at(2), status: PageStatus.Ready },
    { taskId: at(3), status: PageStatus.Working },
    { taskId: at(4), status: PageStatus.NotStarted },
  ];

  it.each<{ name: string; current: TaskId | null; next: TaskId | null }>([
    { name: 'from the first waiting page, the second', current: at(0), next: at(1) },
    { name: 'from the last waiting page, round to the first', current: at(2), next: at(0) },
    { name: 'from a dimmed page, the first waiting', current: at(3), next: at(0) },
    { name: 'with nothing shown, the first waiting', current: null, next: at(0) },
  ])('$name', ({ current, next }) => {
    expect(nextWaiting(rows, current)).toBe(next);
  });

  it('is null when nothing else waits', () => {
    expect(nextWaiting(rows.slice(2), at(2))).toBeNull();
    expect(nextWaiting(rows.slice(3), at(3))).toBeNull();
  });
});
