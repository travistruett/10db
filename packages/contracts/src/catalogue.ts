import { z } from 'zod';
import { AccountId, PatternId, ProjectId } from './ids';
import { Effort, RiskTag, StepRole } from './states';

type ValueOf<T> = T[keyof T];

/** How strong a model is, for routing a step no score can route. */
export const ModelTier = { Fast: 'fast', Balanced: 'balanced', Strongest: 'strongest' } as const;
export type ModelTier = ValueOf<typeof ModelTier>;

/** Where the catalogue came from; none when this daemon has no catalogue at all. */
export const CatalogueSource = {
  Fetched: 'fetched',
  Stored: 'stored',
  Snapshot: 'snapshot',
  None: 'none',
} as const;
export type CatalogueSource = ValueOf<typeof CatalogueSource>;

/** Where a model stands with its maker, as far as 10db can tell. */
export const ModelStatus = {
  Current: 'current',
  Superseded: 'superseded',
  Retired: 'retired',
  Unknown: 'unknown',
  NotRunnable: 'not_runnable',
} as const;
export type ModelStatus = ValueOf<typeof ModelStatus>;

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

/** A model an account can run, as that account reports it. */
export const AccountModelDto = z.object({
  accountId: AccountId,
  model: z.string().min(1),
  /** Null for a model with no catalogue entry. */
  family: z.string().min(1).nullable(),
  /** What the account's CLI is launched with to run this model. */
  launchId: z.string().min(1),
  efforts: z.array(z.enum(Effort)),
  unusable: z.boolean(),
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
  firstSeenAt: Timestamp,
});
export type ModelRowDto = z.infer<typeof ModelRowDto>;

/** Where the catalogue came from and how many models it holds. */
export const CatalogueStatusDto = z.object({
  /** Null when no catalogue has ever been loaded. */
  fetchedAt: Timestamp.nullable(),
  source: z.enum(CatalogueSource),
  models: z.int().min(0),
});
export type CatalogueStatusDto = z.infer<typeof CatalogueStatusDto>;
