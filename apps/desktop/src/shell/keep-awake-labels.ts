import { KeepAwakeMode } from '@10db/contracts';

export const MODE_LABELS: Readonly<Record<KeepAwakeMode, string>> = {
  [KeepAwakeMode.Off]: 'Never keep the Mac awake',
  [KeepAwakeMode.WhileRunning]: 'Keep awake while lanes run',
  [KeepAwakeMode.Always]: 'Always keep the Mac awake',
};
