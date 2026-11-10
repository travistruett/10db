import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { sharedKeptIn } from './turn-holds';

// Workbench spec §4.3, §7.2: a shared hold is listed under exactly one turn of its page.

const taskId = mintId('Task');
const workstreamId = mintId('Workstream');
const T0 = '2026-11-10T10:00:00.000Z';
const T1 = '2026-11-10T10:05:00.000Z';
const INSIDE = '2026-11-10T10:02:00.000Z';
const LATER = '2026-11-10T10:07:00.000Z';
/** Two turns of one run, back to back: the second starts the instant the first ends. */
const first = { taskId, workstreamId, startedAt: T0, endedAt: T1 };
const second = { taskId, workstreamId, startedAt: T1, endedAt: null };
const change = { seq: 1, dropOf: null };

const rows: {
  readonly name: string;
  readonly hold: {
    taskId: typeof taskId;
    workstreamId: typeof workstreamId;
    seq: number;
    grantedAt: string;
  };
  readonly changes: readonly { seq: number; dropOf: number | null }[];
  readonly listedIn: readonly ('first' | 'second')[];
}[] = [
  {
    name: 'granted while the first turn is open',
    hold: { taskId, workstreamId, seq: 1, grantedAt: INSIDE },
    changes: [change],
    listedIn: ['first'],
  },
  {
    name: 'granted the instant the first turn starts',
    hold: { taskId, workstreamId, seq: 1, grantedAt: T0 },
    changes: [change],
    listedIn: ['first'],
  },
  {
    name: 'granted the instant one turn ends and the next starts: the next',
    hold: { taskId, workstreamId, seq: 1, grantedAt: T1 },
    changes: [change],
    listedIn: ['second'],
  },
  {
    name: 'granted while the open turn runs',
    hold: { taskId, workstreamId, seq: 1, grantedAt: LATER },
    changes: [change],
    listedIn: ['second'],
  },
  {
    name: "another run's hold",
    hold: { taskId, workstreamId: mintId('Workstream'), seq: 1, grantedAt: INSIDE },
    changes: [change],
    listedIn: [],
  },
  {
    name: 'a hold whose number is a drop on the chain',
    hold: { taskId, workstreamId, seq: 2, grantedAt: INSIDE },
    changes: [{ seq: 2, dropOf: 1 }],
    listedIn: [],
  },
  {
    name: 'a hold that kept nothing',
    hold: { taskId, workstreamId, seq: 3, grantedAt: INSIDE },
    changes: [change],
    listedIn: [],
  },
];

describe('sharedKeptIn', () => {
  it.each(rows)('$name', ({ hold, changes, listedIn }) => {
    const turns = { first, second };
    expect(
      (['first', 'second'] as const).filter(
        (name) => sharedKeptIn(turns[name], [hold], changes).length > 0,
      ),
    ).toEqual(listedIn);
  });
});
