import { WatchpointLoudness, WatchpointReadVerdict } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { holdsMerge, readVerdict } from './read';
import { readActs } from './read-agreement';

const FLOOR = 0.8;

/** An answered Ask read that meets the guidance and is not destructive, so each row changes only what it names. */
const ASKED = {
  loudness: WatchpointLoudness.Ask,
  asked: true,
  answered: true,
  meets: 0.95,
  destructive: 0.05,
  partial: false,
  floor: FLOOR,
} as const;

interface Row {
  readonly name: string;
  readonly input: Parameters<typeof readVerdict>[0];
  readonly verdict: WatchpointReadVerdict | null;
  readonly holds: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: '1 Hold is held with no read, whatever else is true',
    input: { ...ASKED, loudness: WatchpointLoudness.Hold, asked: false, answered: false },
    verdict: WatchpointReadVerdict.Hold,
    holds: true,
  },
  {
    name: '2 Show is not read',
    input: { ...ASKED, loudness: WatchpointLoudness.Show },
    verdict: null,
    holds: false,
  },
  {
    name: '3 Ask with no judge ready is unread, and holds nothing',
    input: { ...ASKED, asked: false, answered: false, meets: null, destructive: null },
    verdict: WatchpointReadVerdict.Unread,
    holds: false,
  },
  {
    name: '4 no answer (a fallback, a refusal, a timeout) is a doubt',
    input: { ...ASKED, answered: false, meets: null, destructive: null },
    verdict: WatchpointReadVerdict.Doubt,
    holds: true,
  },
  {
    name: '5 a partial read is a doubt even when it reads clean',
    input: { ...ASKED, partial: true },
    verdict: WatchpointReadVerdict.Doubt,
    holds: true,
  },
  {
    name: '6 destructive at the floor is destructive, even when it meets the guidance',
    input: { ...ASKED, meets: 0.99, destructive: FLOOR },
    verdict: WatchpointReadVerdict.Destructive,
    holds: true,
  },
  {
    name: '7 meets at one minus the floor or less is a finding',
    input: { ...ASKED, meets: 1 - FLOOR, destructive: 0.1 },
    verdict: WatchpointReadVerdict.Finding,
    holds: true,
  },
  {
    name: '8 meets at the floor and destructive at one minus it is clean',
    input: { ...ASKED, meets: FLOOR, destructive: 1 - FLOOR },
    verdict: WatchpointReadVerdict.Clean,
    holds: false,
  },
  {
    name: '9 meets in between is a doubt',
    input: { ...ASKED, meets: 0.5, destructive: 0.1 },
    verdict: WatchpointReadVerdict.Doubt,
    holds: true,
  },
  {
    name: '9 destructive in between is a doubt, not clean',
    input: { ...ASKED, meets: 0.95, destructive: 0.5 },
    verdict: WatchpointReadVerdict.Doubt,
    holds: true,
  },
  {
    name: '9 an answer with no probability for a question is a doubt',
    input: { ...ASKED, meets: null, destructive: 0.05 },
    verdict: WatchpointReadVerdict.Doubt,
    holds: true,
  },
];

describe('readVerdict', () => {
  it.each(ROWS)('$name', ({ input, verdict, holds }) => {
    const got = readVerdict(input);
    expect(got).toBe(verdict);
    expect(got === null ? false : holdsMerge(got)).toBe(holds);
  });
});

const NOW = new Date('2026-12-10T12:00:00.000Z');
const daysBefore = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

interface ActsRow {
  readonly name: string;
  readonly input: Parameters<typeof readActs>[0];
  readonly result: ReturnType<typeof readActs>;
}

const ACTS: readonly ActsRow[] = [
  {
    name: "1 the builder's yes acts, even over a clean read sent back and before the week",
    input: { firstAskedAt: daysBefore(1), cleanButSentBack: 2, allowed: true, now: NOW },
    result: { acts: true, ask: false },
  },
  {
    name: "2 the builder's no stays in shadow and never asks again, a week on",
    input: { firstAskedAt: daysBefore(30), cleanButSentBack: 2, allowed: false, now: NOW },
    result: { acts: false, ask: false },
  },
  {
    name: '3 never asked stays in shadow',
    input: { firstAskedAt: null, cleanButSentBack: 0, allowed: null, now: NOW },
    result: { acts: false, ask: false },
  },
  {
    name: '3 less than a week old stays in shadow, and a disagreement does not ask yet',
    input: { firstAskedAt: daysBefore(6.9), cleanButSentBack: 1, allowed: null, now: NOW },
    result: { acts: false, ask: false },
  },
  {
    name: '4 a clean read sent back after the week stays in shadow and asks once',
    input: { firstAskedAt: daysBefore(7), cleanButSentBack: 1, allowed: null, now: NOW },
    result: { acts: false, ask: true },
  },
  {
    name: '5 a week with no disagreement acts, with no minimum of scored reads',
    input: { firstAskedAt: daysBefore(7), cleanButSentBack: 0, allowed: null, now: NOW },
    result: { acts: true, ask: false },
  },
];

describe('readActs', () => {
  it.each(ACTS)('$name', ({ input, result }) => {
    expect(readActs(input)).toEqual(result);
  });
});
