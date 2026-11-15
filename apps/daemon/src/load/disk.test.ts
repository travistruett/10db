import { InboxState } from '@10db/contracts';
import { createTestStore, listInbox, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { diskCard } from './card';
import { createDiskHold, type DiskHold } from './disk';

const GB = 1_000_000_000;
const FLOOR = 20 * GB;
const DISK_TITLE = diskCard({ freeBytes: 0, floorBytes: 0, clearBytes: 0 }).title;

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let inbox: InboxService;
let free: number | null;

function build(): DiskHold {
  return createDiskHold({
    freeBytes: () => free,
    floorBytes: () => FLOOR,
    db: state.db,
    inbox,
    logger: silentLogger,
  });
}

beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  base = test.store;
  state = createStateStore(base, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  seedProject(base);
  free = 100 * GB;
});

afterEach(() => {
  close();
});

const openCards = () =>
  listInbox(base.db, { states: [InboxState.Open] }).filter((c) => c.title === DISK_TITLE);

describe('holding new lanes while free disk is low', () => {
  // Each row is a sequence of free-disk readings, each read once through holding().
  const rows: {
    name: string;
    readings: (number | null)[];
    holding: boolean;
    cards: number;
  }[] = [
    { name: 'above the floor: free, no card', readings: [100 * GB], holding: false, cards: 0 },
    { name: 'below the floor: held, one card', readings: [19 * GB], holding: true, cards: 1 },
    {
      name: 'below the floor for many reads: still one card',
      readings: [19 * GB, 18 * GB, 17.5 * GB, 17 * GB],
      holding: true,
      cards: 1,
    },
    {
      name: 'back above the floor but inside the margin after a hold: still held',
      readings: [19 * GB, 22 * GB],
      holding: true,
      cards: 1,
    },
    {
      name: 'above the floor plus the margin after a hold: clear, card withdrawn',
      readings: [19 * GB, 26 * GB],
      holding: false,
      cards: 0,
    },
    {
      name: 'inside the margin with no hold before: free',
      readings: [22 * GB],
      holding: false,
      cards: 0,
    },
    { name: 'a disk that cannot be read: never holds', readings: [null], holding: false, cards: 0 },
    {
      name: 'a disk that cannot be read during a hold: the hold ends',
      readings: [19 * GB, null],
      holding: false,
      cards: 0,
    },
  ];

  it.each(rows)('$name', ({ readings, holding, cards }) => {
    const disk = build();
    let held = false;
    for (const reading of readings) {
      free = reading;
      held = disk.holding();
    }
    expect(held).toBe(holding);
    expect(openCards()).toHaveLength(cards);
  });

  it('says on the card how much is free, the floor, and when lanes start again', () => {
    free = 12.4 * GB;
    build().holding();
    const body = openCards()[0]?.body ?? '';
    expect(body).toContain('12 GB free');
    expect(body).toContain('20 GB floor');
    expect(body).toContain('25 GB');
  });

  it('reports what it read and the floor', () => {
    free = 30 * GB;
    expect(build().reading()).toEqual({ freeBytes: 30 * GB, floorBytes: FLOOR });
  });

  it('withdraws, when it is made, a disk card a run before it left open', () => {
    free = 10 * GB;
    build().holding();
    expect(openCards()).toHaveLength(1);
    free = 100 * GB;
    build();
    expect(openCards()).toEqual([]);
  });
});
