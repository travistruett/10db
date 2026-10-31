import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';
import { z } from 'zod';

const LANE_AUTO_MODE_SETTING = 'lane_auto_mode';

/** Lanes decide routine permissions with Claude Code's auto mode unless the builder turned it off. */
export function laneAutoMode(db: DbReader): boolean {
  const stored = z.boolean().safeParse(getAppSetting(db, LANE_AUTO_MODE_SETTING));
  return stored.success ? stored.data : true;
}

export function setLaneAutoMode(ctx: WriteContext, on: boolean): void {
  setAppSetting(ctx, LANE_AUTO_MODE_SETTING, on);
}
