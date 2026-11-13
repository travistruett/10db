import { EventType, StakeholderTimersDto } from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

const TIMERS_SETTING_KEY = 'stakeholder-timers';

/** The stored timers, or the defaults (remind after 4 hours, return after 8) when none are stored. */
export function getStakeholderTimers(db: DbReader): StakeholderTimersDto {
  const parsed = StakeholderTimersDto.safeParse(getAppSetting(db, TIMERS_SETTING_KEY) ?? {});
  return parsed.success ? parsed.data : StakeholderTimersDto.parse({});
}

export function setStakeholderTimers(
  ctx: WriteContext,
  input: StakeholderTimersDto,
): StakeholderTimersDto {
  const timers = StakeholderTimersDto.parse(input);
  setAppSetting(ctx, TIMERS_SETTING_KEY, timers);
  ctx.emit({
    type: EventType.StakeholderTimersChanged,
    entityType: 'stakeholder_timers',
    entityId: 'timers',
  });
  return timers;
}
