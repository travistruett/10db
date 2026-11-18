import { describe, expect, it } from 'vitest';
import {
  nextNeeding,
  sessionKey,
  targetIndex,
  type Place,
  type Press,
  type SessionKey,
} from './session-keys';

const press = (key: string, mods: Partial<Omit<Press, 'key'>> = {}): Press => ({
  key,
  meta: false,
  shift: false,
  ctrl: false,
  alt: false,
  ...mods,
});
const on: Place = { onSessions: true, escapeTaken: false };
const off: Place = { onSessions: false, escapeTaken: false };

describe('sessionKey', () => {
  const rows: readonly {
    readonly name: string;
    readonly press: Press;
    readonly place: Place;
    readonly want: SessionKey | null;
  }[] = [
    { name: '⌘T on Sessions', press: press('t', { meta: true }), place: on, want: { kind: 'new' } },
    {
      name: '⌘T off Sessions',
      press: press('t', { meta: true }),
      place: off,
      want: { kind: 'new' },
    },
    {
      name: '⌘W on Sessions',
      press: press('w', { meta: true }),
      place: on,
      want: { kind: 'close' },
    },
    {
      name: '⌘W off Sessions is the window’s',
      press: press('w', { meta: true }),
      place: off,
      want: null,
    },
    {
      name: '⌘⇧T reopens',
      press: press('T', { meta: true, shift: true }),
      place: on,
      want: { kind: 'reopen' },
    },
    {
      name: '⌘⇧T off Sessions',
      press: press('T', { meta: true, shift: true }),
      place: off,
      want: null,
    },
    {
      name: '⌘⇧↩ is free',
      press: press('Enter', { meta: true, shift: true }),
      place: on,
      want: null,
    },
    {
      name: '⌘⇧↩ off Sessions',
      press: press('Enter', { meta: true, shift: true }),
      place: off,
      want: null,
    },
    {
      name: '⌘⇧D is Changes',
      press: press('D', { meta: true, shift: true }),
      place: on,
      want: { kind: 'changes' },
    },
    {
      name: '⌘⇧D off Sessions',
      press: press('D', { meta: true, shift: true }),
      place: off,
      want: null,
    },
    { name: '⌘1', press: press('1', { meta: true }), place: on, want: { kind: 'go', index: 0 } },
    { name: '⌘8', press: press('8', { meta: true }), place: on, want: { kind: 'go', index: 7 } },
    {
      name: '⌘9 is the last tab',
      press: press('9', { meta: true }),
      place: on,
      want: { kind: 'last' },
    },
    { name: '⌘0 is nothing', press: press('0', { meta: true }), place: on, want: null },
    {
      name: '⌘⇧[ is previous',
      press: press('{', { meta: true, shift: true }),
      place: on,
      want: { kind: 'prev' },
    },
    {
      name: '⌘⇧] is next',
      press: press('}', { meta: true, shift: true }),
      place: on,
      want: { kind: 'next' },
    },
    {
      name: '⌃⇧Tab is previous',
      press: press('Tab', { ctrl: true, shift: true }),
      place: on,
      want: { kind: 'prev' },
    },
    {
      name: '⌃Tab is next',
      press: press('Tab', { ctrl: true }),
      place: on,
      want: { kind: 'next' },
    },
    {
      name: '⌘J goes to the next tab that needs you',
      press: press('j', { meta: true }),
      place: on,
      want: { kind: 'next_needing' },
    },
    { name: '⌘J off Sessions', press: press('j', { meta: true }), place: off, want: null },
    { name: '⌘N is never taken', press: press('n', { meta: true }), place: on, want: null },
    { name: 'Esc stops the turn', press: press('Escape'), place: on, want: { kind: 'stop' } },
    {
      name: 'Esc with a menu open (or a waiting card’s note) is theirs',
      press: press('Escape'),
      place: { onSessions: true, escapeTaken: true },
      want: null,
    },
    { name: 'Esc off Sessions', press: press('Escape'), place: off, want: null },
    { name: '⌘⌥T is not ⌘T', press: press('t', { meta: true, alt: true }), place: on, want: null },
  ];
  it.each(rows)('$name', ({ press: p, place, want }) => {
    expect(sessionKey(p, place)).toEqual(want);
  });
});

describe('targetIndex', () => {
  it.each([
    { key: { kind: 'go', index: 1 } as const, selected: 0, count: 3, want: 1 },
    { key: { kind: 'go', index: 5 } as const, selected: 0, count: 3, want: null },
    { key: { kind: 'last' } as const, selected: 0, count: 3, want: 2 },
    { key: { kind: 'prev' } as const, selected: 0, count: 3, want: 2 },
    { key: { kind: 'next' } as const, selected: 2, count: 3, want: 0 },
    { key: { kind: 'next' } as const, selected: 0, count: 0, want: null },
  ])('$key.kind from $selected of $count', ({ key, selected, count, want }) => {
    expect(targetIndex(key, selected, count)).toBe(want);
  });
});

describe('nextNeeding', () => {
  const needing = [false, true, false, true];
  it('goes to the second, then the fourth, then the second again', () => {
    expect(nextNeeding(needing, 0)).toBe(1);
    expect(nextNeeding(needing, 1)).toBe(3);
    expect(nextNeeding(needing, 3)).toBe(1);
  });
  it('is nothing when no tab needs the builder', () => {
    expect(nextNeeding([false, false], 0)).toBeNull();
  });
});
