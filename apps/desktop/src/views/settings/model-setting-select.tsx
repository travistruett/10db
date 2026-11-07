import type { AccountId, ModelSetting } from '@10db/contracts';
import { Select } from '@mantine/core';
import { useModels } from '../../daemon/model-queries';
import { NO_SETTING, settingChoices, settingValue } from './model-setting-options';

interface Common {
  /** The accessible name; also the field's label unless `hideLabel` is set. */
  readonly label: string;
  readonly description?: string;
  readonly hideLabel?: boolean;
  /** Whose models are offered: these accounts, or every account for null. */
  readonly accountIds: readonly AccountId[] | null;
  readonly value: ModelSetting | null;
  /** Shown while nothing is chosen. */
  readonly placeholder?: string;
}

/** A field that must hold a setting, or one that can also hold none (an inherited role, a task with no override). */
export type ModelSettingSelectProps = Common &
  (
    | { readonly noneLabel: string; readonly onChange: (setting: ModelSetting | null) => void }
    | { readonly noneLabel?: undefined; readonly onChange: (setting: ModelSetting) => void }
  );

/** One dropdown for the setting used everywhere a model is chosen: Automatic, a tier, Top of tier or a model. */
export function ModelSettingSelect(props: ModelSettingSelectProps) {
  const models = useModels();
  const { groups, settings } = settingChoices({
    models: models.data ?? null,
    accountIds: props.accountIds,
    current: props.value,
    noneLabel: props.noneLabel,
  });
  const choose = (value: string | null) => {
    if (value === null) return;
    const setting = settings.get(value);
    if (setting === undefined) return;
    if (props.noneLabel !== undefined) props.onChange(setting);
    else if (setting !== null) props.onChange(setting);
  };
  const shown =
    props.value !== null
      ? settingValue(props.value)
      : props.noneLabel === undefined
        ? null
        : NO_SETTING;
  return (
    <Select
      {...(props.hideLabel ? { 'aria-label': props.label } : { label: props.label })}
      {...(props.description === undefined ? {} : { description: props.description })}
      {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
      data={groups}
      value={shown}
      allowDeselect={false}
      onChange={choose}
    />
  );
}
