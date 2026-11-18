import type { StatusDto, StatusLine } from '@10db/contracts';
import type { Clock, Timer } from '../clock';

/** A hold is shown once it has lasted this long, and kept this long after it lifts. */
export const STATUS_HYSTERESIS_MS = 2 * 60_000;

/** What a source says about a hold; the service adds the key and when it began. */
export type StatusHold = Pick<StatusLine, 'kind' | 'label' | 'line' | 'details' | 'culprits'>;

export interface StatusService {
  /** A hold starts, or a hold that continues is reworded. */
  hold(key: string, hold: StatusHold): void;
  /** The hold lifted. */
  release(key: string): void;
  /** The lines shown now, oldest first. */
  current(): StatusDto;
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
 * shown set, or the words of a shown line, change.
 */
export function createStatusService(deps: {
  readonly clock: Clock;
  readonly onChange: (status: StatusDto) => void;
}): StatusService {
  const entries = new Map<string, Entry>();

  const visible = (entry: Entry): boolean => entry.phase !== 'pending';
  const current = (): StatusDto => ({
    lines: [...entries]
      .filter(([, entry]) => visible(entry))
      .sort(([, a], [, b]) => a.since.getTime() - b.since.getTime())
      .map(([key, entry]) => ({ key, ...entry.hold, since: entry.since.toISOString() })),
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
      const reworded = JSON.stringify(entry.hold) !== JSON.stringify(hold);
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
    current,
  };
}
