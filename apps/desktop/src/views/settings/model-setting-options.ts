import {
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

const TIER_ORDER: readonly ModelTier[] = [ModelTier.Fast, ModelTier.Balanced, ModelTier.Strongest];

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

const GENERAL: readonly ModelSetting[] = [
  { kind: 'automatic' },
  ...TIER_ORDER.map((tier): ModelSetting => ({ kind: 'tier', tier })),
  { kind: 'top_of_tier' },
];

/** A model an account can run now: not replaced by its maker, and one 10db can launch. */
function isOffered(model: ModelRowDto, accountIds: readonly AccountId[] | null): boolean {
  if (model.status === ModelStatus.Superseded || model.status === ModelStatus.NotRunnable)
    return false;
  return model.availableOn.some((id) => accountIds === null || accountIds.includes(id));
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
  const offered = (input.models ?? []).filter((m) => isOffered(m, input.accountIds));
  for (const tier of [...TIER_ORDER, null]) {
    const inTier = offered.filter((m) => m.tier === tier);
    if (inTier.length === 0) continue;
    groups.push({
      group: tier === null ? 'Unknown tier' : `${TIER_LABEL[tier]} models`,
      items: inTier.map((m) =>
        item(
          { kind: 'model', model: m.model },
          m.status === ModelStatus.Unknown ? `${m.name} (Unknown)` : m.name,
        ),
      ),
    });
  }
  const { current } = input;
  // A saved model the accounts no longer offer stays listed; while the list loads it shows by its ID.
  if (current?.kind === 'model' && !settings.has(settingValue(current)))
    groups.push({
      group: 'Current setting',
      items: [
        item(current, input.models === null ? current.model : `${current.model} (not offered)`),
      ],
    });
  return { groups, settings };
}
