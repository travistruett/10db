import { RiskTag } from '@10db/contracts';
import { getAppSetting, listPatterns, setAppSetting, setPatterns } from '@10db/db';
import type { NewPattern, WriteContext } from '@10db/db';

/** The app setting that records the pattern was offered, so deleting or editing it sticks. */
export const PATTERNS_SEEDED_KEY = 'patterns.seeded';

/** Work that touches security, sign-in or a migration is where the dearest model earns its cost. */
const HIGH_RISK_PATTERN: NewPattern = {
  name: 'High-risk work',
  match: {
    roles: [],
    riskTags: [RiskTag.Security, RiskTag.Auth, RiskTag.Migration],
    areas: [],
    retryOnly: false,
  },
  setting: { kind: 'top_of_tier' },
};

/**
 * Offers the high-risk pattern once, on the first start that has not seen it. A start that finds
 * the builder's own global patterns adds nothing beside them. Either way the offer is recorded, so
 * a pattern the builder later deletes or edits is not put back.
 */
export function seedPatterns(ctx: WriteContext): void {
  if (getAppSetting(ctx.tx, PATTERNS_SEEDED_KEY) === true) return;
  if (!listPatterns(ctx.tx).some((p) => p.projectId === null))
    setPatterns(ctx, null, [HIGH_RISK_PATTERN]);
  setAppSetting(ctx, PATTERNS_SEEDED_KEY, true);
}
