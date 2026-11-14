import { SessionsSettingsDto } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { StateStore } from '../events';

// UI spec §5.7: Settings › Sessions, kept as one app setting. A missing or unreadable value reads as
// the defaults: a reply notifies.

const KEY = 'sessions';
const DEFAULTS: SessionsSettingsDto = { notifyReplies: true };

export function sessionsSettings(db: DbReader): SessionsSettingsDto {
  const parsed = SessionsSettingsDto.safeParse(getAppSetting(db, KEY));
  return parsed.success ? parsed.data : DEFAULTS;
}

export function setSessionsSettings(
  state: StateStore,
  input: SessionsSettingsDto,
): SessionsSettingsDto {
  state.write((ctx) => {
    setAppSetting(ctx, KEY, { ...input });
  });
  return sessionsSettings(state.db);
}
