import {
  Effort,
  PersonaId,
  type AccountId,
  type CellSetting,
  type ModelTier,
  type PersonaDto,
  type StepRole,
} from '@10db/contracts';
import { NumberInput, Select, Stack, type ComboboxProps } from '@mantine/core';
import { useState } from 'react';
import { automaticAtLeast, TOP_OF_TIERS, topOfTier } from './model-setting-options';
import { ModelSettingSelect } from './model-setting-select';
import { TIER_LABEL } from './model-labels';
import { EFFORT_LABELS } from './rigor-labels';

const NONE = 'none';
const ANY_TIER = 'any';

const isTier = (value: string): value is ModelTier => TOP_OF_TIERS.some((t) => t === value);
const isEffort = (value: string): value is Effort => Object.values(Effort).some((e) => e === value);

/** The minimum Intelligence field; it commits when it loses focus or Enter is pressed, never per keystroke. */
function MinimumField({
  minimum,
  onCommit,
}: {
  readonly minimum: number | null;
  readonly onCommit: (minimum: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | number>(minimum ?? '');
  const commit = () => {
    const next = draft === '' ? null : Number(draft);
    if (next !== minimum) onCommit(next);
  };
  return (
    <NumberInput
      label="At least"
      aria-label="Minimum Intelligence"
      description="The lowest Intelligence score 10db will accept."
      min={0}
      max={100}
      allowDecimal={false}
      placeholder="No minimum"
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/**
 * The three fields of a cell or a kind's override: persona, model and effort. A field left on its none choice
 * inherits: `noneLabel` says from where. Every change is reported whole, with the other fields as they were.
 */
export function CellFields({
  role,
  value,
  personas,
  accountIds,
  noneLabel,
  comboboxProps,
  onChange,
}: {
  readonly role: StepRole;
  readonly value: CellSetting;
  readonly personas: readonly PersonaDto[];
  /** Whose models the model field offers; null for every account. */
  readonly accountIds: readonly AccountId[] | null;
  readonly noneLabel: string;
  /** For fields inside a popover: keeps each list inside it, so choosing from a list does not close the popover. */
  readonly comboboxProps?: ComboboxProps;
  readonly onChange: (next: CellSetting) => void;
}) {
  // A persona of the role that is archived stays listed while the cell still names it.
  const choices = personas.filter(
    (p) => p.role === role && (!p.archived || p.id === value.personaId),
  );
  const { model } = value;
  const lists = comboboxProps === undefined ? {} : { comboboxProps };
  return (
    <Stack gap="sm">
      <Select
        label="Persona"
        {...lists}
        allowDeselect={false}
        data={[
          { value: NONE, label: noneLabel },
          ...choices.map((p) => ({
            value: p.id,
            label: p.archived ? `${p.name} (archived)` : p.name,
          })),
        ]}
        value={value.personaId ?? NONE}
        onChange={(next) => {
          if (next === null) return;
          onChange({ ...value, personaId: next === NONE ? null : PersonaId.parse(next) });
        }}
      />
      <ModelSettingSelect
        label="Model"
        {...lists}
        accountIds={accountIds}
        value={model}
        noneLabel={noneLabel}
        onChange={(setting) => {
          onChange({ ...value, model: setting });
        }}
      />
      {model?.kind === 'automatic' ? (
        <MinimumField
          key={model.minimum ?? 'none'}
          minimum={model.minimum ?? null}
          onCommit={(minimum) => {
            onChange({ ...value, model: automaticAtLeast(minimum) });
          }}
        />
      ) : null}
      {model?.kind === 'top_of_tier' ? (
        <Select
          label="Tier"
          {...lists}
          allowDeselect={false}
          data={[
            { value: ANY_TIER, label: 'Any tier' },
            ...TOP_OF_TIERS.map((tier) => ({ value: tier, label: TIER_LABEL[tier] })),
          ]}
          value={model.tier ?? ANY_TIER}
          onChange={(next) => {
            if (next === null) return;
            onChange({ ...value, model: topOfTier(isTier(next) ? next : null) });
          }}
        />
      ) : null}
      <Select
        label="Effort"
        {...lists}
        allowDeselect={false}
        data={[
          { value: NONE, label: noneLabel },
          ...Object.values(Effort).map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
        ]}
        value={value.effort ?? NONE}
        onChange={(next) => {
          if (next === null) return;
          onChange({ ...value, effort: isEffort(next) ? next : null });
        }}
      />
    </Stack>
  );
}
