import { deleteAppSetting, getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { StateStore } from '../events';

/** The one switch for the whole app: the builder's choice, absent until they make one. */
export const SELF_UPDATE_ENABLED_KEY = 'self_update.enabled';

export interface SelfUpdateSetting {
  /** Whether 10db installs main's build by itself. */
  readonly enabled: boolean;
  /** True while the builder has made no choice, so `enabled` is the default. */
  readonly isDefault: boolean;
}

/**
 * On until the builder turns it off. What the app follows is not a setting: it is the repository
 * baked into the build (`build-info.json`), so the switch says whether, never from where.
 */
export function selfUpdateSetting(db: DbReader): SelfUpdateSetting {
  const stored = getAppSetting(db, SELF_UPDATE_ENABLED_KEY);
  return typeof stored === 'boolean'
    ? { enabled: stored, isDefault: false }
    : { enabled: true, isDefault: true };
}

/** How many minutes a staged update waits for an idle moment before the factory drains for it. */
export const SELF_UPDATE_WAIT_MINUTES_KEY = 'self_update.wait_minutes';
export const DEFAULT_WAIT_MINUTES = 15;

/** The builder's wait limit in minutes; 0 drains the moment a build is staged. */
export function selfUpdateWaitMinutes(db: DbReader): number {
  const stored = getAppSetting(db, SELF_UPDATE_WAIT_MINUTES_KEY);
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 0
    ? stored
    : DEFAULT_WAIT_MINUTES;
}

/** Stores the builder's wait limit; null forgets it, so the default applies again. */
export function setSelfUpdateWaitMinutes(state: StateStore, minutes: number | null): void {
  state.write((ctx) => {
    if (minutes === null) deleteAppSetting(ctx, SELF_UPDATE_WAIT_MINUTES_KEY);
    else setAppSetting(ctx, SELF_UPDATE_WAIT_MINUTES_KEY, minutes);
  });
}

/** Stores the builder's choice; null forgets it, so the default applies again. */
export function setSelfUpdateChoice(state: StateStore, enabled: boolean | null): void {
  state.write((ctx) => {
    if (enabled === null) deleteAppSetting(ctx, SELF_UPDATE_ENABLED_KEY);
    else setAppSetting(ctx, SELF_UPDATE_ENABLED_KEY, enabled);
  });
}
