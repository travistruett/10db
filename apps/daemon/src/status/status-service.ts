import type { BusyLevel, StatusDto, StatusLine } from '@10db/contracts';
import type { Clock, Timer } from '../clock';

/** A hold is shown once it has lasted this long, and kept this long after it lifts. */
export const STATUS_HYSTERESIS_MS = 2 * 60_000;

/** Below this level the client draws nothing for how busy the Mac is. */
export const BUSY_DRAWN_FROM = 0.5;

/** What a source says about a hold; the service adds the key and when it began. */
export type StatusHold = Pick<
  StatusLine,
  'kind' | 'label' | 'line' | 'details' | 'busiest' | 'culprits'
>;

export interface StatusService {
  /** A hold starts, or a hold that continues is reworded. */
  hold(key: string, hold: StatusHold): void;
  /** The hold lifted. */
  release(key: string): void;
  /**
   * How busy the Mac is, from each load sample, and while holding the plain names of what is busiest. The
   * client hears of it only when the level, rounded to tenths, `holding` or those names change, so a
   * steady load writes no event per sample, and none while the level is under `BUSY_DRAWN_FROM` before
   * and after, where nothing is drawn.
   */
  busy(level: number, holding: boolean, busiest?: readonly string[]): void;
  /** The lines shown now, oldest first, and the busy level. */
  current(): StatusDto;
  /** Cancels every timer and drops every hold; a hold made after it is ignored, so nothing fires again. */
  stop(): void;
}

type Phase = 'pending' | 'shown' | 'lingering';

interface Entry {
  hold: StatusHold;
  readonly since: Date;
  phase: Phase;
  timer: Timer | null;
}

/**
 * The holds that pause work and end by themselves, with the hysteresis that keeps a flapping one from
 * flickering: pending until it has lasted `STATUS_HYSTERESIS_MS`, shown, then lingering for as long
 * after it lifts. It lives in memory, so a restart starts every hold again. `onChange` runs when the
 * shown set, the words of a shown line's label (not its sentence or the busy processes behind it) or the
 * busy level change.
 */
export function createStatusService(deps: {
  readonly clock: Clock;
  readonly onChange: (status: StatusDto) => void;
}): StatusService {
  const entries = new Map<string, Entry>();
  let stopped = false;
  let busy: BusyLevel | null = null;

  const visible = (entry: Entry): boolean => entry.phase !== 'pending';
  const current = (): StatusDto => ({
    lines: [...entries]
      .filter(([, entry]) => visible(entry))
      .sort(([, a], [, b]) => a.since.getTime() - b.since.getTime())
      .map(([key, entry]) => ({ key, ...entry.hold, since: entry.since.toISOString() })),
    busy,
  });
  const changed = (): void => {
    deps.onChange(current());
  };
  const arm = (key: string, entry: Entry, then: () => void): void => {
    entry.timer?.cancel();
    entry.timer = deps.clock.setTimeout(() => {
      entry.timer = null;
      if (entries.get(key) === entry) then();
    }, STATUS_HYSTERESIS_MS);
  };

  return {
    hold(key, hold) {
      if (stopped) return;
      const entry = entries.get(key);
      if (entry === undefined) {
        const created: Entry = { hold, since: deps.clock.now(), phase: 'pending', timer: null };
        entries.set(key, created);
        arm(key, created, () => {
          created.phase = 'shown';
          changed();
        });
        return;
      }
      // The sentence carries the load, which changes at nearly every sample and is not drawn.
      const reworded = entry.hold.kind !== hold.kind || entry.hold.label !== hold.label;
      entry.hold = hold;
      if (entry.phase === 'lingering') {
        entry.timer?.cancel();
        entry.timer = null;
        entry.phase = 'shown';
        // It never left the shown set, so nothing changes unless the words did.
        if (reworded) changed();
        return;
      }
      if (entry.phase === 'shown' && reworded) changed();
    },
    release(key) {
      const entry = entries.get(key);
      if (entry === undefined || entry.phase === 'lingering') return;
      if (entry.phase === 'pending') {
        entry.timer?.cancel();
        entries.delete(key);
        return;
      }
      entry.phase = 'lingering';
      arm(key, entry, () => {
        entries.delete(key);
        changed();
      });
    },
    busy(level, holding, busiest = []) {
      if (stopped) return;
      const next = { level: Math.round(level * 10) / 10, holding, busiest: [...busiest] };
      const previous = busy;
      if (
        previous?.level === next.level &&
        previous.holding === next.holding &&
        previous.busiest.join('\n') === next.busiest.join('\n')
      )
        return;
      busy = next;
      if (previous !== null && previous.level < BUSY_DRAWN_FROM && next.level < BUSY_DRAWN_FROM)
        return;
      changed();
    },
    current,
    stop() {
      stopped = true;
      for (const entry of entries.values()) entry.timer?.cancel();
      entries.clear();
      busy = null;
    },
  };
}
