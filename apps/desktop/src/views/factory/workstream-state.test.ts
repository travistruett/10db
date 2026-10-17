import { WorkstreamState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { canCancel, canRetry, STATE_COLORS, STATE_LABELS } from './workstream-state';

const ALL = Object.values(WorkstreamState);

describe('workstream state presentation', () => {
  it.each(ALL)('%s has a color and a sentence-case label', (state) => {
    expect(STATE_COLORS[state]).toBeTruthy();
    expect(STATE_LABELS[state]).toMatch(/^[A-Z][a-z]/);
  });

  it('uses the DESIGN.md status colors', () => {
    expect(STATE_COLORS[WorkstreamState.Running]).toBe('blue');
    expect(STATE_COLORS[WorkstreamState.WaitingHuman]).toBe('yellow');
    expect(STATE_COLORS[WorkstreamState.PausedLimit]).toBe('orange');
    expect(STATE_COLORS[WorkstreamState.Failed]).toBe('red');
    expect(STATE_COLORS[WorkstreamState.Done]).toBe('green');
    expect(STATE_COLORS[WorkstreamState.Queued]).toBe('gray');
  });

  it('offers Cancel for every non-terminal state and Retry only for FAILED', () => {
    expect(ALL.filter(canCancel).sort()).toEqual(
      ALL.filter((s) => !['DONE', 'FAILED', 'CANCELLED'].includes(s)).sort(),
    );
    expect(ALL.filter(canRetry)).toEqual([WorkstreamState.Failed]);
  });
});
