import {
  isPickableModel,
  ModelStatus,
  ModelTier,
  type AccountId,
  type ModelRowDto,
  type ModelSetting,
} from '@10db/contracts';
import type { ComboboxItem, ComboboxItemGroup } from '@mantine/core';
import { TIER_LABEL } from './model-labels';

/** The select value of "no setting": an inherited role or a task with no override. */
export const NO_SETTING = 'none';

const TIER_ORDER: readonly ModelTier[] = [
  ModelTier.Efficient,
  ModelTier.Balanced,
  ModelTier.Capable,
  ModelTier.Frontier,
];

/** The select value for a setting. Each distinct setting has its own. */
export function settingValue(setting: ModelSetting | null): string {
  if (setting === null) return NO_SETTING;
  switch (setting.kind) {
    case 'automatic':
      return 'automatic';
    case 'tier':
      return `tier:${setting.tier}`;
    case 'top_of_tier':
      return 'top_of_tier';
    case 'model':
      return `model:${setting.model}`;
  }
}

/** Whether two settings are the same choice; null, no setting, equals only null. */
export function sameSetting(a: ModelSetting | null, b: ModelSetting | null): boolean {
  return settingValue(a) === settingValue(b);
}

/** How a setting reads when it is not one of the models offered. */
function plainLabel(setting: ModelSetting): string {
  switch (setting.kind) {
    case 'automatic':
      return 'Automatic';
    case 'tier':
      return TIER_LABEL[setting.tier];
    case 'top_of_tier':
      return 'Top of tier';
    case 'model':
      return setting.model;
  }
}

/**
 * A setting in a few words, for a cell that cannot show the whole select: Auto, with its minimum when it has
 * one, a tier, the top of a tier, or a model by its name (its ID when `names` does not know it).
 */
export function settingSummary(
  setting: ModelSetting,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  switch (setting.kind) {
    case 'automatic':
      return setting.minimum === undefined ? 'Auto' : `Auto, at least ${String(setting.minimum)}`;
    case 'tier':
      return TIER_LABEL[setting.tier];
    case 'top_of_tier':
      return setting.tier === undefined ? 'Top of tier' : `Top of ${TIER_LABEL[setting.tier]}`;
    case 'model':
      return names.get(setting.model) ?? setting.model;
  }
}

/** Automatic with a minimum Intelligence, or with none for null. */
export function automaticAtLeast(minimum: number | null): ModelSetting {
  return minimum === null ? { kind: 'automatic' } : { kind: 'automatic', minimum };
}

/** The top of one tier, or of whichever the router finds best for null. */
export function topOfTier(tier: ModelTier | null): ModelSetting {
  return tier === null ? { kind: 'top_of_tier' } : { kind: 'top_of_tier', tier };
}

/** The tiers a Top of tier setting can name, in the order lists show them. */
export const TOP_OF_TIERS: readonly ModelTier[] = TIER_ORDER;

const GENERAL: readonly ModelSetting[] = [
  { kind: 'automatic' },
  ...TIER_ORDER.map((tier): ModelSetting => ({ kind: 'tier', tier })),
  { kind: 'top_of_tier' },
];

/** A model an account offers that can be chosen by hand: the daemon's own rule, `isPickableModel`. */
function isOffered(model: ModelRowDto, accountIds: readonly AccountId[] | null): boolean {
  if (!isPickableModel(model.status)) return false;
  return model.availableOn.some((id) => accountIds === null || accountIds.includes(id));
}

/** How a model reads in a list: its name, with a replaced or Unknown one marked. */
export const modelLabel = (model: ModelRowDto): string => {
  switch (model.status) {
    case ModelStatus.Unknown:
      return `${model.name} (Unknown)`;
    case ModelStatus.Superseded:
      return `${model.name} (superseded)`;
    case ModelStatus.Current:
    case ModelStatus.Retired:
    case ModelStatus.NotRunnable:
      return model.name;
  }
};

/** The heading of a tier's models in a list; models the catalogue does not rank go under "Unknown tier". */
export const tierGroupLabel = (tier: ModelTier | null): string =>
  tier === null ? 'Unknown tier' : `${TIER_LABEL[tier]} models`;

/** The tiers in the order lists show them, the models with none last. */
export const LIST_TIER_ORDER: readonly (ModelTier | null)[] = [...TIER_ORDER, null];

/**
 * The models the accounts offer, one group per tier and Unknown tier last, each entry made by `entry`.
 * `accountIds` null means every account.
 */
export function offeredModelGroups(
  models: readonly ModelRowDto[],
  accountIds: readonly AccountId[] | null,
  entry: (model: ModelRowDto) => ComboboxItem,
): ComboboxItemGroup<ComboboxItem>[] {
  const offered = models.filter((m) => isOffered(m, accountIds));
  const groups: ComboboxItemGroup<ComboboxItem>[] = [];
  for (const tier of LIST_TIER_ORDER) {
    const inTier = offered.filter((m) => m.tier === tier);
    if (inTier.length === 0) continue;
    groups.push({ group: tierGroupLabel(tier), items: inTier.map(entry) });
  }
  return groups;
}

export function unlistedLabel(
  model: string,
  row: ModelRowDto | undefined,
  loading: boolean,
): string {
  if (loading) return model;
  if (row?.status === ModelStatus.Superseded) return `${row.name} (superseded)`;
  if (row?.status === ModelStatus.NotRunnable) return `${row.name} (not runnable)`;
  return `${row?.name ?? model} (not offered)`;
}

export interface SettingChoices {
  readonly groups: ComboboxItemGroup<ComboboxItem>[];
  /** Every select value in `groups`, mapped back to its setting. */
  readonly settings: ReadonlyMap<string, ModelSetting | null>;
}

/**
 * The choices for a setting: Automatic, the tiers and Top of tier, then the models the accounts
 * offer by tier, Unknown ones last and marked. `accountIds` null means every account. A saved model
 * the accounts no longer offer stays listed and marked, so the form never shows a blank.
 */
export function settingChoices(input: {
  /** Null while the model list loads. */
  readonly models: readonly ModelRowDto[] | null;
  readonly accountIds: readonly AccountId[] | null;
  readonly current: ModelSetting | null;
  /** The label of "no setting"; absent when the setting must be one of the others. */
  readonly noneLabel?: string | undefined;
}): SettingChoices {
  const settings = new Map<string, ModelSetting | null>();
  const item = (setting: ModelSetting | null, label: string) => {
    const value = settingValue(setting);
    settings.set(value, setting);
    return { value, label };
  };
  const groups: ComboboxItemGroup<ComboboxItem>[] = [
    {
      group: 'Let 10db choose',
      items: [
        ...(input.noneLabel === undefined ? [] : [item(null, input.noneLabel)]),
        ...GENERAL.map((setting) => item(setting, plainLabel(setting))),
      ],
    },
  ];
  groups.push(
    ...offeredModelGroups(input.models ?? [], input.accountIds, (m) =>
      item({ kind: 'model', model: m.model }, modelLabel(m)),
    ),
  );
  const { current } = input;
  // A saved model that is not in the list stays there, with the reason; while the list loads it shows by its ID.
  if (current?.kind === 'model' && !settings.has(settingValue(current))) {
    const row = (input.models ?? []).find((m) => m.model === current.model);
    groups.push({
      group: 'Current setting',
      items: [item(current, unlistedLabel(current.model, row, input.models === null))],
    });
  }
  return { groups, settings };
}
