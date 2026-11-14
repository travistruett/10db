import type { ModelRowDto, ShapeModelOption } from '@10db/contracts';
import { Group, Select, Text, type ComboboxData } from '@mantine/core';
import { useModels } from '../daemon/model-queries';
import {
  LIST_TIER_ORDER,
  modelLabel,
  tierGroupLabel,
} from '../views/settings/model-setting-options';

/** The default option's value: Select cannot hold null as an option, and null is what it means. */
const DEFAULT_VALUE = '';

/** How an option reads: the model's name and marks as Settings shows them, else its ID while the list loads. */
export function optionLabel(model: string, rows: ReadonlyMap<string, ModelRowDto>): string {
  const row = rows.get(model);
  return row === undefined ? model : modelLabel(row);
}

/** The account's models as the Select takes them: one group per tier, in the daemon's order within it. */
function groupedByTier(
  offered: readonly ShapeModelOption[],
  rows: ReadonlyMap<string, ModelRowDto>,
): ComboboxData {
  return LIST_TIER_ORDER.flatMap((tier) => {
    const items = offered
      .filter((option) => option.tier === tier)
      .map((option) => ({ value: option.model, label: optionLabel(option.model, rows) }));
    return items.length === 0 ? [] : [{ group: tierGroupLabel(tier), items }];
  });
}

export interface ModelPickerProps {
  readonly offered: readonly ShapeModelOption[];
  /** The model the account's role resolves to, named in the Default option; null before it is known. */
  readonly default: string | null;
  /** The model picked; null is the default. */
  readonly picked: string | null;
  /** A turn runs or waits: a change takes effect between turns, so the control is off and says so. */
  readonly busy: boolean;
  /** A pick is on its way: the control is off, with nothing said. */
  readonly pending?: boolean;
  /** The daemon's refusal, shown at the control. */
  readonly error?: string | null;
  /** The agent's name, drawn before the model ("Claude Code ·"). */
  readonly prefix?: string;
  readonly width?: number;
  readonly onPick: (model: string | null) => void;
}

/**
 * Chooses the model a conversation's next turn runs on, grouped by tier with the default first. A model
 * the account no longer offers stays in the list as "(not offered)", so it never reads as the default.
 */
export function ModelPicker({
  offered,
  default: defaultModel,
  picked,
  busy,
  pending = false,
  error = null,
  prefix,
  width = 260,
  onPick,
}: ModelPickerProps) {
  const models = useModels(null);
  if (offered.length === 0) return null;
  const rows = new Map((models.data ?? []).map((row) => [row.model, row]));
  const defaultLabel =
    defaultModel === null ? 'Default' : `Default (${optionLabel(defaultModel, rows)})`;
  const gone = picked !== null && !offered.some((option) => option.model === picked);
  const data: ComboboxData = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...(gone ? [{ value: picked, label: `${picked} (not offered)` }] : []),
    ...groupedByTier(offered, rows),
  ];
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      {busy && !pending ? (
        <Text size="xs" c="dimmed" pt={6} style={{ whiteSpace: 'nowrap' }}>
          Change the model between turns
        </Text>
      ) : null}
      <Select
        aria-label="Model"
        size="xs"
        w={width}
        data={data}
        value={picked ?? DEFAULT_VALUE}
        allowDeselect={false}
        disabled={busy || pending}
        error={error}
        {...(prefix === undefined
          ? {}
          : {
              leftSection: (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {prefix} ·
                </Text>
              ),
              leftSectionWidth: 8 + prefix.length * 7,
              leftSectionPointerEvents: 'none' as const,
            })}
        onChange={(value) => {
          if (value === null) return;
          onPick(value === DEFAULT_VALUE ? null : value);
        }}
      />
    </Group>
  );
}
