import type { ModelRowDto, ShapeModelOption, ShapeViewDto } from '@10db/contracts';
import { Group, Select, Text, type ComboboxData } from '@mantine/core';
import { useModels } from '../../daemon/model-queries';
import { useChooseShapeModel } from '../../daemon/shape-queries';
import { LIST_TIER_ORDER, modelLabel, tierGroupLabel } from '../settings/model-setting-options';

/** The default option's value: Select cannot hold null as an option, and null is what it means. */
const DEFAULT_VALUE = '';

/** How an option reads: the model's name and marks as Settings shows them, else its ID while the list loads. */
function optionLabel(model: string, rows: ReadonlyMap<string, ModelRowDto>): string {
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
  readonly view: ShapeViewDto;
}

/**
 * Chooses the model the conversation's next turn runs on. A change takes effect between turns, so
 * the control is off while one runs or waits; the daemon's refusal shows beside it.
 */
export function ModelPicker({ view }: ModelPickerProps) {
  const choose = useChooseShapeModel();
  const models = useModels(null);
  const { offered } = view.models;
  if (offered.length === 0) return null;

  const busy = view.turn.running || view.turn.queued > 0 || choose.isPending;
  const picked = view.shape.model;
  const rows = new Map((models.data ?? []).map((row) => [row.model, row]));
  const defaultLabel =
    view.models.default === null
      ? 'Default'
      : `Default (${optionLabel(view.models.default, rows)})`;
  // A pick the account no longer offers still shows, rather than reading as the default.
  const gone = picked !== null && !offered.some((option) => option.model === picked);
  const data: ComboboxData = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...(gone ? [{ value: picked, label: `${picked} (not offered)` }] : []),
    ...groupedByTier(offered, rows),
  ];

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      {busy && !choose.isPending ? (
        <Text size="xs" c="dimmed" pt={6} style={{ whiteSpace: 'nowrap' }}>
          Change the model between turns
        </Text>
      ) : null}
      <Select
        aria-label="Model"
        size="xs"
        w={260}
        data={data}
        value={picked ?? DEFAULT_VALUE}
        allowDeselect={false}
        disabled={busy}
        error={choose.error?.message ?? null}
        onChange={(value) => {
          if (value === null) return;
          choose.mutate({ shapeId: view.shape.id, model: value === DEFAULT_VALUE ? null : value });
        }}
      />
    </Group>
  );
}
