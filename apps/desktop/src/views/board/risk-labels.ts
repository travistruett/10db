import { RiskTag } from '@10db/contracts';

/** A risk tag in plain words, as the task drawer's picker shows it. */
export const RISK_LABEL: Readonly<Record<RiskTag, string>> = {
  [RiskTag.Security]: 'Security',
  [RiskTag.Auth]: 'Sign-in and permissions',
  [RiskTag.Migration]: 'Database migration',
  [RiskTag.Dependency]: 'Dependencies',
};
