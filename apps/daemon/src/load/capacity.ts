import { CapacitySettingsDto } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { StateStore } from '../events';

// Settings › This Mac › Capacity, kept as one app setting. A missing or unreadable value reads as the
// defaults: four lanes across all projects, and a 20 GB free-disk floor.

const KEY = 'capacity';
export const DEFAULT_CAPACITY: CapacitySettingsDto = { machineLaneCap: 4, diskFloorGb: 20 };

export function capacitySettings(db: DbReader): CapacitySettingsDto {
  const parsed = CapacitySettingsDto.safeParse(getAppSetting(db, KEY));
  return parsed.success ? parsed.data : DEFAULT_CAPACITY;
}

export function setCapacitySettings(
  state: StateStore,
  input: CapacitySettingsDto,
): CapacitySettingsDto {
  state.write((ctx) => {
    setAppSetting(ctx, KEY, { ...input });
  });
  return capacitySettings(state.db);
}
