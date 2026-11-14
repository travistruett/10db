import { ModelTier, Rigor, StepRole, type CellSetting, type KindInput } from '@10db/contracts';
import { getAppSetting, insertKind, listKinds, patchKind, setAppSetting } from '@10db/db';
import type { WriteContext } from '@10db/db';

/** The app setting that records the kinds were offered, so a kind the builder deletes or edits stays so. */
export const KINDS_SEEDED_KEY = 'kinds.seeded';

/** The app setting that records the seeded kinds were given what implies them, so the builder's change to it stays. */
export const KINDS_IMPLIED_SEEDED_KEY = 'kinds.implied-seeded';

/** The hazards whose presence on a task gives it a seeded kind, by the kind's key. */
const SEEDED_IMPLIED_BY: Readonly<Record<string, readonly string[]>> = {
  migration: ['migrations'],
  dependency: ['deps'],
};

const tier = (name: ModelTier): CellSetting => ({
  personaId: null,
  model: { kind: 'tier', tier: name },
  effort: 'high',
});

const topOfCapable: CellSetting = {
  personaId: null,
  model: { kind: 'top_of_tier', tier: ModelTier.Capable },
  effort: 'high',
};

/**
 * Work whose mistakes cost the most puts the strongest model on review: finding what is missing is
 * the harder half. Writing the code gets the top of Capable.
 */
const RISKY_OVERRIDES: KindInput['overrides'] = {
  [StepRole.Plan]: tier(ModelTier.Capable),
  [StepRole.Implement]: topOfCapable,
  [StepRole.Review]: tier(ModelTier.Frontier),
};

/** The kinds a first start offers; the builder edits, removes and adds from there. */
export const SEEDED_KINDS: readonly KindInput[] = [
  {
    key: 'security',
    label: 'Security',
    description: 'Changes how the app protects data, secrets, trust boundaries or untrusted input.',
    minimumRigor: Rigor.Careful,
    alwaysReviewed: true,
    failsAtLimit: true,
    toInbox: true,
    overrides: RISKY_OVERRIDES,
  },
  {
    key: 'auth',
    label: 'Auth',
    description: 'Changes who may sign in or what a signed-in person may do.',
    minimumRigor: Rigor.Careful,
    alwaysReviewed: true,
    failsAtLimit: true,
    toInbox: true,
    overrides: RISKY_OVERRIDES,
  },
  {
    key: 'migration',
    label: 'Migration',
    description: 'Changes stored data or its shape in a way that cannot be undone by a revert.',
    minimumRigor: Rigor.Careful,
    alwaysReviewed: true,
    ownCopy: true,
    toInbox: true,
    addsSteps: [StepRole.PlanReview],
    overrides: { ...RISKY_OVERRIDES, [StepRole.PlanReview]: tier(ModelTier.Frontier) },
    impliedBy: ['migrations'],
  },
  {
    key: 'dependency',
    label: 'Dependency',
    description: 'Adds, removes or upgrades a package the project depends on.',
    minimumRigor: Rigor.Standard,
    alwaysReviewed: true,
    ownCopy: true,
    toInbox: true,
    impliedBy: ['deps'],
  },
  {
    key: 'schema',
    label: 'Schema',
    description: 'Changes the shape of a contract, a database table or a file format others read.',
    minimumRigor: Rigor.Careful,
  },
  {
    key: 'infra',
    label: 'Infra',
    description: 'Changes CI, deployment or build configuration.',
    minimumRigor: Rigor.Careful,
  },
  { key: 'ui', label: 'UI', description: 'Changes what a screen shows or how it behaves.' },
  { key: 'docs', label: 'Docs', description: 'Changes documentation or comments only.' },
];

/**
 * Offers the seeded kinds once, on the first start that has not seen them, and records that, so a kind
 * the builder later deletes or edits is not put back. A key the builder already made is left alone.
 */
export function seedKinds(ctx: WriteContext): void {
  if (getAppSetting(ctx.tx, KINDS_SEEDED_KEY) !== true) {
    const have = new Set(listKinds(ctx.tx).map((k) => k.key));
    for (const kind of SEEDED_KINDS) if (!have.has(kind.key)) insertKind(ctx, kind);
    setAppSetting(ctx, KINDS_SEEDED_KEY, true);
  }
  seedImpliedBy(ctx);
}

/**
 * Gives the migration and dependency kinds what implies them, once, for an install that seeded them before
 * the field existed. A kind that already names something keeps it, and nothing is put back afterwards.
 */
function seedImpliedBy(ctx: WriteContext): void {
  if (getAppSetting(ctx.tx, KINDS_IMPLIED_SEEDED_KEY) === true) return;
  for (const kind of listKinds(ctx.tx)) {
    const implied = SEEDED_IMPLIED_BY[kind.key];
    if (implied !== undefined && kind.impliedBy.length === 0)
      patchKind(ctx, kind.id, { impliedBy: [...implied] });
  }
  setAppSetting(ctx, KINDS_IMPLIED_SEEDED_KEY, true);
}
