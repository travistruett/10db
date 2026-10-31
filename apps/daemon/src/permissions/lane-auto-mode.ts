import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';
import { z } from 'zod';

const LANE_AUTO_MODE_SETTING = 'lane_auto_mode';

/**
 * Lanes decide routine permissions with Claude Code's auto mode unless the builder turned it off.
 * A stored value that is not a boolean is not trusted: the lane runs in default mode and `onInvalid`
 * is told.
 */
export function laneAutoMode(
  db: DbReader,
  onInvalid: (stored: unknown) => void = () => undefined,
): boolean {
  const stored = getAppSetting(db, LANE_AUTO_MODE_SETTING);
  if (stored === undefined) return true;
  const parsed = z.boolean().safeParse(stored);
  if (parsed.success) return parsed.data;
  onInvalid(stored);
  return false;
}

export function setLaneAutoMode(ctx: WriteContext, on: boolean): void {
  setAppSetting(ctx, LANE_AUTO_MODE_SETTING, on);
}
