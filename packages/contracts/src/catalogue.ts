import { z } from 'zod';
import { AccountId, PatternId, ProjectId } from './ids';
import { Effort, RiskTag, StepRole } from './states';

type ValueOf<T> = T[keyof T];

/** How strong a model is, for routing a step no score can route. */
export const ModelTier = { Fast: 'fast', Balanced: 'balanced', Strongest: 'strongest' } as const;
export type ModelTier = ValueOf<typeof ModelTier>;

const TIER_NAMES: ReadonlySet<string> = new Set(Object.values(ModelTier));

/** Whether `value` names a tier, as a planned step's model does when its account offers nothing to run it on. */
export function isModelTier(value: string): value is ModelTier {
  return TIER_NAMES.has(value);
}

/** Where the catalogue came from; none when this daemon has no catalogue at all. */
export const CatalogueSource = {
  Fetched: 'fetched',
  Stored: 'stored',
  Snapshot: 'snapshot',
  None: 'none',
} as const;
export type CatalogueSource = ValueOf<typeof CatalogueSource>;

/** How the last fetch of the catalogue went; off when this daemon is set not to fetch it. */
export const CatalogueAttempt = {
  NotTried: 'not_tried',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Off: 'off',
} as const;
export type CatalogueAttempt = ValueOf<typeof CatalogueAttempt>;

/** Where a model stands with its maker, as far as 10db can tell. */
export const ModelStatus = {
  Current: 'current',
  Superseded: 'superseded',
  Retired: 'retired',
  Unknown: 'unknown',
  NotRunnable: 'not_runnable',
} as const;
export type ModelStatus = ValueOf<typeof ModelStatus>;

/**
 * Whether a model can be chosen by hand from an account's list: every model the account offers except one its
 * maker has retired and one 10db cannot run. A replaced model and an Unknown one can be chosen, and lists mark
 * them. A model with no status yet (a profile written before the catalogue ranked it) can be chosen too.
 */
export function isPickableModel(status: ModelStatus | null): boolean {
  return status !== ModelStatus.Retired && status !== ModelStatus.NotRunnable;
}

/**
 * What an account's refusal of a model rests on. Claude Code's own `model_not_found` is `error`: final until the
 * account's list changes. An `invalid_request` or `unknown` error whose text names the model is `wording`: the words
 * alone cannot tell a real refusal from a config error ("Tool use with model X is not supported"), so that mark ends
 * on its own and one later session settles it.
 */
export const ModelMarkBasis = { Error: 'error', Wording: 'wording' } as const;
export type ModelMarkBasis = ValueOf<typeof ModelMarkBasis>;

const Timestamp = z.iso.datetime();

/** What a step, role or pattern asks of the router: leave it to 10db, a tier, the best, or one model. */
export const ModelSetting = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('automatic') }),
  z.object({ kind: z.literal('tier'), tier: z.enum(ModelTier) }),
  z.object({ kind: z.literal('top_of_tier') }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
]);
export type ModelSetting = z.infer<typeof ModelSetting>;

/** The setting for a role, for one project or (with no project) everywhere. */
export const RoleSettingDto = z.object({
  role: z.enum(StepRole),
  projectId: ProjectId.nullable(),
  setting: ModelSetting,
});
export type RoleSettingDto = z.infer<typeof RoleSettingDto>;

/** What a pattern applies to. An empty list, or false, means any. */
export const PatternMatch = z.object({
  roles: z.array(z.enum(StepRole)).default([]),
  riskTags: z.array(z.enum(RiskTag)).default([]),
  areas: z.array(z.string().min(1)).default([]),
  retryOnly: z.boolean().default(false),
});
export type PatternMatch = z.infer<typeof PatternMatch>;

/** A rule that gives matching steps a setting; the lowest position that matches wins. */
export const PatternDto = z.object({
  id: PatternId,
  projectId: ProjectId.nullable(),
  name: z.string().min(1),
  match: PatternMatch,
  setting: ModelSetting,
  position: z.int().min(0),
});
export type PatternDto = z.infer<typeof PatternDto>;

/** A pattern as the builder writes it; the daemon gives it an id and its place in the list. */
export const PatternInput = z.object({
  name: z.string().trim().min(1),
  match: PatternMatch.prefault({}),
  setting: ModelSetting,
});
export type PatternInput = z.infer<typeof PatternInput>;

/** The role settings and patterns of one scope: a project's own, or the ones that apply everywhere. */
export const ModelSettingsDto = z.object({
  roles: z.array(RoleSettingDto),
  patterns: z.array(PatternDto),
});
export type ModelSettingsDto = z.infer<typeof ModelSettingsDto>;

const noRoleTwice = (roles: readonly { readonly role: string }[]) =>
  new Set(roles.map((r) => r.role)).size === roles.length;

/**
 * What a form changes in one scope's settings. A role listed here is set, or, with a null setting,
 * cleared: a project's role then uses the global setting, and a global role 10db's default. A role
 * left out keeps its setting. `patterns`, when given, replaces the whole list in the order sent.
 */
export const ModelSettingsInput = z.object({
  roles: z
    .array(z.object({ role: z.enum(StepRole), setting: ModelSetting.nullable() }))
    .refine(noRoleTwice, { message: 'A role is set twice' })
    .default([]),
  patterns: z.array(PatternInput).optional(),
});
export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

/** A model an account can run, as that account reports it. */
export const AccountModelDto = z.object({
  accountId: AccountId,
  model: z.string().min(1),
  /** Null for a model with no catalogue entry. */
  family: z.string().min(1).nullable(),
  /** What the account's CLI is launched with to run this model. */
  launchId: z.string().min(1),
  efforts: z.array(z.enum(Effort)),
  /** Whether 10db routes around the model on this account now; a mark from an error's wording stops counting at its end. */
  unusable: z.boolean(),
  /**
   * When the mark that came from an error's wording alone ends; null when the model is not marked, or its mark is
   * final (from `model_not_found`, or from wording that a second refusal confirmed). Past it the model is routed
   * to again, and the next session on it either clears the mark or makes it final.
   */
  wordingMarkEndsAt: Timestamp.nullable(),
  /** The price of this account's own offer; null for a flat-rate plan or a gateway with no catalogue entry. */
  inputPrice: z.number().min(0).nullable(),
  /** The price of this account's own offer; null for a flat-rate plan or a gateway with no catalogue entry. */
  outputPrice: z.number().min(0).nullable(),
  lastSeenAt: Timestamp,
});
export type AccountModelDto = z.infer<typeof AccountModelDto>;

/** One row of the model list: what the maker publishes, joined with where 10db can run it. */
export const ModelRowDto = z.object({
  model: z.string().min(1),
  name: z.string().min(1),
  /** Maker and family are null for a model with no catalogue entry. */
  maker: z.string().min(1).nullable(),
  family: z.string().min(1).nullable(),
  tier: z.enum(ModelTier).nullable(),
  status: z.enum(ModelStatus),
  availableOn: z.array(AccountId),
  providers: z.array(z.string().min(1)),
  /** The maker's list price, not what any one account pays. */
  inputPrice: z.number().min(0).nullable(),
  /** The maker's list price, not what any one account pays. */
  outputPrice: z.number().min(0).nullable(),
  intelligence: z.number().nullable(),
  coding: z.number().nullable(),
  outputTokensPerSecond: z.number().nullable(),
  /** Steps 10db has run on this model. */
  stepsRun: z.int().min(0),
  /** The earliest of its profiles; null for a model with no profile, which has nothing to date it by. */
  firstSeenAt: Timestamp.nullable(),
});
export type ModelRowDto = z.infer<typeof ModelRowDto>;

/** Where the catalogue came from and how many models it holds. */
export const CatalogueStatusDto = z.object({
  /** Null when no catalogue has ever been loaded. */
  fetchedAt: Timestamp.nullable(),
  source: z.enum(CatalogueSource),
  models: z.int().min(0),
  /** The last fetch's outcome, which the source alone does not say: a failed fetch leaves the old copy in use. */
  lastAttempt: z.enum(CatalogueAttempt),
});
export type CatalogueStatusDto = z.infer<typeof CatalogueStatusDto>;
