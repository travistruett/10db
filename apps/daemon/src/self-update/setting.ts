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

/** Stores the builder's choice; null forgets it, so the default applies again. */
export function setSelfUpdateChoice(state: StateStore, enabled: boolean | null): void {
  state.write((ctx) => {
    if (enabled === null) deleteAppSetting(ctx, SELF_UPDATE_ENABLED_KEY);
    else setAppSetting(ctx, SELF_UPDATE_ENABLED_KEY, enabled);
  });
}
