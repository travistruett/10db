import {
  AdmissionHoldKind,
  WorkstreamState,
  type AdmissionDto,
  type AdmissionHoldDto,
} from '@10db/contracts';
import { countLanes, listWorkstreams, type DbReader } from '@10db/db';
import {
  CLEAR_MARGIN_BYTES,
  gigabytes,
  type DiskHold,
  type LoadGuard,
  type OverloadEpisode,
} from '../load';

/** What the admission gate weighs, read once. */
export interface AdmissionFacts {
  /** The overload on now, or null. */
  readonly overload: OverloadEpisode | null;
  /** Free disk while it holds lanes, or null when it doesn't. */
  readonly disk: {
    readonly freeBytes: number;
    readonly floorBytes: number;
    readonly clearBytes: number;
  } | null;
  /** Lanes running across all projects, the machine's cap, and the lanes queued behind it. */
  readonly lanes: { readonly running: number; readonly cap: number; readonly queued: number };
}

function clockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** What holds new work now, one line each, in the order load, disk, lane cap. */
export function admissionHolds(facts: AdmissionFacts): AdmissionHoldDto[] {
  const holds: AdmissionHoldDto[] = [];
  const { overload, disk, lanes } = facts;
  if (overload !== null)
    holds.push({
      kind: AdmissionHoldKind.Load,
      line: `New lanes and gates wait: the load has stayed above ${String(overload.factor * overload.cores)} (${String(overload.factor)}× the ${String(overload.cores)} cores) since ${clockTime(overload.since)}.`,
    });
  if (disk !== null)
    holds.push({
      kind: AdmissionHoldKind.Disk,
      line: `New lanes wait: ${gigabytes(disk.freeBytes)} GB free, below the ${gigabytes(disk.floorBytes)} GB floor. They start again above ${gigabytes(disk.clearBytes)} GB.`,
    });
  if (lanes.running >= lanes.cap && lanes.queued > 0)
    holds.push({
      kind: AdmissionHoldKind.LaneCap,
      line: `${String(lanes.running)} of ${String(lanes.cap)} lanes are running across all projects; queued work waits for one to finish.`,
    });
  return holds;
}

export interface Admission {
  /** Whether the scheduler launches nothing this tick: an overload, low disk or an update's drain. */
  held(): boolean;
  /** What holds new work now and the readings behind it, for Factory. */
  status(): AdmissionDto;
}

export interface AdmissionOptions {
  readonly load: Pick<LoadGuard, 'holding' | 'episode'>;
  readonly disk: DiskHold;
  readonly drain: { readonly draining: boolean };
  /** The lane cap across all projects, read each time. */
  laneCap(): number;
  readonly db: DbReader;
}

/**
 * The one gate in front of new lanes. The lane cap is not part of `held`: the scheduler counts it per
 * lane, since a warm session may close to make room. It is reported here so Factory can say why
 * queued work waits.
 */
export function createAdmission(opts: AdmissionOptions): Admission {
  return {
    held: () => opts.load.holding() || opts.disk.holding() || opts.drain.draining,
    status() {
      const holdingDisk = opts.disk.holding();
      const reading = opts.disk.reading();
      const cap = opts.laneCap();
      const running = countLanes(opts.db).global;
      const queued = listWorkstreams(opts.db, { states: [WorkstreamState.Queued] }).length;
      return {
        holds: admissionHolds({
          overload: opts.load.episode(),
          disk:
            holdingDisk && reading.freeBytes !== null
              ? {
                  freeBytes: reading.freeBytes,
                  floorBytes: reading.floorBytes,
                  clearBytes: reading.floorBytes + CLEAR_MARGIN_BYTES,
                }
              : null,
          lanes: { running, cap, queued },
        }),
        freeBytes: reading.freeBytes,
        diskFloorBytes: reading.floorBytes,
        lanesRunning: running,
        machineLaneCap: cap,
      };
    },
  };
}
