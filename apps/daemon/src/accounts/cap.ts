import { isMetered } from '@10db/contracts';
import { accountSpendUsd, type AccountRow, type DbReader } from '@10db/db';
import { monthOf, usageWindow, type MonthWindow } from './month';

export interface CapStatus {
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly window: MonthWindow;
}

/** A metered account's spend this month against its cap; null when it has no cap (accounts spec §6). */
export function capStatus(db: DbReader, account: AccountRow, now: Date): CapStatus | null {
  if (account.monthlyCapUsd === null || !isMetered(account.kind)) return null;
  const window = monthOf(now);
  return {
    spentUsd: accountSpendUsd(db, account.id, usageWindow(window)),
    capUsd: account.monthlyCapUsd,
    window,
  };
}
