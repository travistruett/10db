import { AdmissionHoldKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { admissionHolds, type AdmissionFacts } from './admission';

const GB = 1_000_000_000;
// Local time, so the line reads 09:05 in any time zone.
const SINCE = new Date(2026, 10, 14, 9, 5);

const LOAD_LINE =
  'New lanes and gates wait: the load has stayed above 20 (2× the 10 cores) since 09:05.';
const DISK_LINE =
  'New lanes wait: 12 GB free, below the 20 GB floor. They start again above 25 GB.';
const CAP_LINE =
  '3 of 3 lanes are running across all projects; queued work waits for one to finish.';

const calm: AdmissionFacts = {
  overload: null,
  disk: null,
  lanes: { running: 1, cap: 3, queued: 0 },
};
const overload = { since: SINCE, load: 25, cores: 10, factor: 2 };
const lowDisk = { freeBytes: 12.4 * GB, floorBytes: 20 * GB, clearBytes: 25 * GB };

describe('admissionHolds', () => {
  const rows: { name: string; facts: AdmissionFacts; lines: [AdmissionHoldKind, string][] }[] = [
    { name: 'nothing holds', facts: calm, lines: [] },
    {
      name: 'the load alone',
      facts: { ...calm, overload },
      lines: [[AdmissionHoldKind.Load, LOAD_LINE]],
    },
    {
      name: 'low disk alone',
      facts: { ...calm, disk: lowDisk },
      lines: [[AdmissionHoldKind.Disk, DISK_LINE]],
    },
    {
      name: 'the lane cap, with work queued',
      facts: { ...calm, lanes: { running: 3, cap: 3, queued: 2 } },
      lines: [[AdmissionHoldKind.LaneCap, CAP_LINE]],
    },
    {
      name: 'the lane cap reached with nothing queued holds nothing',
      facts: { ...calm, lanes: { running: 3, cap: 3, queued: 0 } },
      lines: [],
    },
    {
      name: 'all three, in the order load, disk, cap',
      facts: { overload, disk: lowDisk, lanes: { running: 3, cap: 3, queued: 1 } },
      lines: [
        [AdmissionHoldKind.Load, LOAD_LINE],
        [AdmissionHoldKind.Disk, DISK_LINE],
        [AdmissionHoldKind.LaneCap, CAP_LINE],
      ],
    },
  ];

  it.each(rows)('$name', ({ facts, lines }) => {
    expect(admissionHolds(facts).map((h) => [h.kind, h.line])).toEqual(lines);
  });
});
