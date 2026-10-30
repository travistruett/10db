import { describe, expect, it } from 'vitest';
import { workstreamDto } from '../../test/fixtures';
import { ordinal, queuePlaces, runNextNote } from './queue-place';

describe('queuePlaces', () => {
  it('numbers the queued workstreams in the order the scheduler takes them', () => {
    const old = workstreamDto({ state: 'QUEUED', createdAt: '2026-10-29T10:00:00.000Z' });
    const newer = workstreamDto({ state: 'QUEUED', createdAt: '2026-10-29T11:00:00.000Z' });
    const pushed = workstreamDto({
      state: 'QUEUED',
      createdAt: '2026-10-29T12:00:00.000Z',
      runNextAt: '2026-10-29T12:30:00.000Z',
    });
    const running = workstreamDto({ state: 'RUNNING', createdAt: '2026-10-29T09:00:00.000Z' });
    const places = queuePlaces([newer, running, old, pushed]);
    expect([pushed, old, newer].map((w) => places.get(w.id))).toEqual([1, 2, 3]);
    expect(places.has(running.id)).toBe(false);
  });
});

describe('ordinal', () => {
  it.each([
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [112, '112th'],
  ])('writes %i as %s', (n, text) => {
    expect(ordinal(n)).toBe(text);
  });
});

describe('runNextNote', () => {
  it.each([
    {
      name: 'a task with nothing to wait for',
      title: 'Fix the gate',
      waitingOn: [],
      note: 'Fix the gate is next in line for a free lane.',
    },
    {
      name: 'a task waiting on one dependency',
      title: 'Fix the gate',
      waitingOn: ['Base'],
      note: 'Fix the gate will run once Base is done, before the other queued tasks.',
    },
    {
      name: 'a task waiting on two',
      title: 'Fix the gate',
      waitingOn: ['Base', 'Schema'],
      note: 'Fix the gate will run once Base and Schema are done, before the other queued tasks.',
    },
  ])('says it for $name', ({ title, waitingOn, note }) => {
    expect(runNextNote(title, waitingOn)).toBe(note);
  });
});
