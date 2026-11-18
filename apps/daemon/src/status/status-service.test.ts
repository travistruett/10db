import { describe, expect, it } from 'vitest';
import type { StatusDto } from '@10db/contracts';
import { ManualClock } from '../clock';
import { createStatusService, STATUS_HYSTERESIS_MS, type StatusHold } from './status-service';

const hold = (line = 'Holding new lanes'): StatusHold => ({
  kind: 'admission_hold',
  label: 'Held',
  line,
  details: 'why',
  culprits: [],
});

function setup() {
  const clock = new ManualClock();
  const changes: StatusDto[] = [];
  const status = createStatusService({ clock, onChange: (dto) => changes.push(dto) });
  const shown = () => status.current().lines.map((l) => l.key);
  return { clock, changes, status, shown };
}

describe('the status line hysteresis', () => {
  it('shows a hold only once it has lasted 2 minutes', () => {
    const { clock, status, shown, changes } = setup();
    status.hold('load', hold());
    expect(shown()).toEqual([]);
    clock.advance(STATUS_HYSTERESIS_MS - 1);
    expect(shown()).toEqual([]);
    clock.advance(1);
    expect(shown()).toEqual(['load']);
    expect(changes).toHaveLength(1);
    expect(status.current().lines[0]?.since).toBe('2026-10-13T12:00:00.000Z');
  });

  it('never shows a hold that lifts while pending', () => {
    const { clock, status, shown, changes } = setup();
    status.hold('load', hold());
    clock.advance(60_000);
    status.release('load');
    clock.advance(STATUS_HYSTERESIS_MS * 2);
    expect(shown()).toEqual([]);
    expect(changes).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('keeps a shown hold for 2 minutes after it lifts, then drops it', () => {
    const { clock, status, shown, changes } = setup();
    status.hold('load', hold());
    clock.advance(STATUS_HYSTERESIS_MS);
    status.release('load');
    clock.advance(STATUS_HYSTERESIS_MS - 1);
    expect(shown()).toEqual(['load']);
    clock.advance(1);
    expect(shown()).toEqual([]);
    expect(changes).toHaveLength(2);
  });

  it('goes straight back to shown when a hold returns while lingering', () => {
    const { clock, status, shown, changes } = setup();
    status.hold('load', hold());
    clock.advance(STATUS_HYSTERESIS_MS);
    status.release('load');
    clock.advance(60_000);
    status.hold('load', hold());
    clock.advance(STATUS_HYSTERESIS_MS * 2);
    expect(shown()).toEqual(['load']);
    expect(changes).toHaveLength(1);
  });

  it('rewords a shown line and tells the client, and orders lines oldest first', () => {
    const { clock, status, changes } = setup();
    status.hold('a', hold('first'));
    clock.advance(30_000);
    status.hold('b', hold('second'));
    clock.advance(STATUS_HYSTERESIS_MS);
    status.hold('a', hold('first, reworded'));
    expect(status.current().lines.map((l) => l.line)).toEqual(['first, reworded', 'second']);
    expect(changes).toHaveLength(3);
  });

  it('starts fresh in a new service, which is a restart', () => {
    const { status } = setup();
    expect(status.current()).toEqual({ lines: [] });
  });
});
