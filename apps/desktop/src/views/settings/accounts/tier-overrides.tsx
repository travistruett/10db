import { ModelTier, type AccountId, type ModelRowDto } from '@10db/contracts';
import { Select, Stack, Text, TextInput } from '@mantine/core';
import { useModelOffers, useModels } from '../../../daemon/model-queries';
import { TIER_LABEL } from '../model-labels';
import { modelLabel, offeredModelGroups, unlistedLabel } from '../model-setting-options';
import type { AccountFormValues } from './account-form-values';

const TIERS: readonly ModelTier[] = [ModelTier.Fast, ModelTier.Balanced, ModelTier.Strongest];

/** The select value of a tier left to 10db. A model's value carries a prefix, so no model ID can equal it. */
const AUTOMATIC = 'automatic';
const MODEL_PREFIX = 'model:';

function TierSelect({
  label,
  accountId,
  models,
  current,
  onChange,
}: {
  readonly label: string;
  readonly accountId: AccountId;
  readonly models: readonly ModelRowDto[];
  /** The model ID the tier is overridden to; empty for Automatic. */
  readonly current: string;
  readonly onChange: (model: string) => void;
}) {
  const groups = offeredModelGroups(models, [accountId], (m) => ({
    value: `${MODEL_PREFIX}${m.model}`,
    label: modelLabel(m),
  }));
  const listed = groups.some((g) => g.items.some((i) => i.value === `${MODEL_PREFIX}${current}`));
  // A saved override the account no longer offers stays listed and marked, so the field is never blank.
  const unlisted =
    current === '' || listed
      ? []
      : [
          {
            group: 'Current setting',
            items: [
              {
                value: `${MODEL_PREFIX}${current}`,
                label: unlistedLabel(
                  current,
                  models.find((m) => m.model === current),
                  false,
                ),
              },
            ],
          },
        ];
  return (
    <Select
      size="md"
      label={label}
      data={[{ value: AUTOMATIC, label: 'Automatic' }, ...groups, ...unlisted]}
      value={current === '' ? AUTOMATIC : `${MODEL_PREFIX}${current}`}
      allowDeselect={false}
      onChange={(value) => {
        if (value === null) return;
        onChange(value.startsWith(MODEL_PREFIX) ? value.slice(MODEL_PREFIX.length) : '');
      }}
    />
  );
}

/**
 * One field per tier for the model the account runs there instead of 10db's automatic choice: a dropdown of
 * the models the account offers, grouped by tier, or a text field when the account reports no list (a gateway
 * that lists none), where only the builder knows the IDs.
 */
export function TierOverrides({
  accountId,
  values,
  onChange,
}: {
  readonly accountId: AccountId;
  readonly values: AccountFormValues;
  readonly onChange: (next: AccountFormValues) => void;
}) {
  const models = useModels();
  const offers = useModelOffers();
  const set = (tier: ModelTier, model: string) => {
    onChange({ ...values, tierOverrides: { ...values.tierOverrides, [tier]: model } });
  };
  const hasList = offers.data?.some((offer) => offer.accountId === accountId);
  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={500}>
          Model for each tier
        </Text>
        <Text size="xs" c="dimmed">
          Automatic lets 10db choose the model for each tier. Pick one to run that tier on it
          instead.
        </Text>
      </div>
      {models.data === undefined || hasList === undefined
        ? null
        : TIERS.map((tier) =>
            hasList ? (
              <TierSelect
                key={tier}
                label={`${TIER_LABEL[tier]} model`}
                accountId={accountId}
                models={models.data}
                current={values.tierOverrides[tier]?.trim() ?? ''}
                onChange={(model) => {
                  set(tier, model);
                }}
              />
            ) : (
              <TextInput
                key={tier}
                size="md"
                label={`${TIER_LABEL[tier]} model`}
                placeholder="Automatic"
                description="The model ID this account runs for the tier. Leave empty for Automatic."
                value={values.tierOverrides[tier] ?? ''}
                onChange={(e) => {
                  set(tier, e.currentTarget.value);
                }}
              />
            ),
          )}
    </Stack>
  );
}
