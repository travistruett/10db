import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isTerminal,
  WORKSTREAM_TRANSITIONS,
  WorkstreamState as S,
  type WorkstreamState,
} from './index';

const ALL = Object.values(S);

describe('workstream state machine', () => {
  it.each<[WorkstreamState, WorkstreamState]>([
    [S.Queued, S.Starting],
    [S.Starting, S.Running],
    [S.Starting, S.Verifying],
    [S.Running, S.HandingOff],
    [S.HandingOff, S.Running],
    [S.Running, S.Verifying],
    [S.Verifying, S.Done],
    [S.Verifying, S.Queued],
    [S.Running, S.WaitingHuman],
    [S.HandingOff, S.WaitingHuman],
    [S.WaitingHuman, S.Running],
    [S.WaitingHuman, S.HandingOff],
    [S.WaitingHuman, S.Queued],
    [S.Running, S.PausedLimit],
    [S.PausedLimit, S.Queued],
    [S.Running, S.Recovering],
    [S.Recovering, S.Queued],
    [S.Recovering, S.Failed],
    [S.Failed, S.Queued],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[WorkstreamState, WorkstreamState]>([
    [S.Queued, S.Running],
    [S.Queued, S.Done],
    [S.Running, S.Done],
    [S.PausedLimit, S.Running],
    [S.Done, S.Queued],
    [S.Cancelled, S.Queued],
    [S.Recovering, S.Running],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('lets every non-terminal state be cancelled', () => {
    const stuck = ALL.filter((s) => !isTerminal(s) && !canTransition(s, S.Cancelled));
    expect(stuck).toEqual([]);
  });

  it('gives DONE and CANCELLED no exits, and FAILED only a retry', () => {
    expect(WORKSTREAM_TRANSITIONS[S.Done]).toEqual([]);
    expect(WORKSTREAM_TRANSITIONS[S.Cancelled]).toEqual([]);
    expect(WORKSTREAM_TRANSITIONS[S.Failed]).toEqual([S.Queued]);
  });

  it('reaches DONE from QUEUED', () => {
    const seen = new Set<WorkstreamState>([S.Queued]);
    const frontier: WorkstreamState[] = [S.Queued];
    while (frontier.length > 0) {
      const next = frontier.pop();
      if (next === undefined) break;
      for (const to of WORKSTREAM_TRANSITIONS[next]) {
        if (!seen.has(to)) {
          seen.add(to);
          frontier.push(to);
        }
      }
    }
    expect(seen.has(S.Done)).toBe(true);
  });
});
