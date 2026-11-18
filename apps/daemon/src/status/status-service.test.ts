import { describe, expect, it } from 'vitest';
import type { StatusDto } from '@10db/contracts';
import { ManualClock } from '../clock';
import { createStatusService, STATUS_HYSTERESIS_MS, type StatusHold } from './status-service';

const hold = (line = 'Holding new lanes'): StatusHold => ({
  kind: 'admission_hold',
  label: 'Held',
  line,
  details: 'why',
  busiest: [],
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
});

describe('the busy level', () => {
  const rows: { name: string; steps: [number, boolean][]; events: number }[] = [
    { name: 'the first reading is a change', steps: [[0.3, false]], events: 1 },
    {
      name: 'the same tenth is no change',
      steps: [
        [0.31, false],
        [0.34, false],
      ],
      events: 1,
    },
    {
      name: 'crossing a tenth is a change',
      steps: [
        [0.34, false],
        [0.36, false],
      ],
      events: 2,
    },
    {
      name: 'holding flipping is a change',
      steps: [
        [1, false],
        [1, true],
      ],
      events: 2,
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const { status, changes } = setup();
      for (const [level, holding] of row.steps) status.busy(level, holding);
      expect(changes).toHaveLength(row.events);
    });
  }

  it('reports the level rounded to tenths, and null before any reading', () => {
    const { status } = setup();
    expect(status.current().busy).toBeNull();
    status.busy(0.74, false);
    expect(status.current().busy).toEqual({ level: 0.7, holding: false });
  });

  it('does not tell the client when only the busy processes behind a shown line change', () => {
    const { clock, status, changes } = setup();
    status.hold('a', hold());
    clock.advance(STATUS_HYSTERESIS_MS);
    status.hold('a', {
      ...hold(),
      busiest: ['Docker'],
      culprits: [{ name: 'x', cpuPct: 5, owner: 'y' }],
    });
    expect(changes).toHaveLength(1);
    expect(status.current().lines[0]?.busiest).toEqual(['Docker']);
  });
});
