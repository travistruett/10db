import {
  Effort,
  type ModelRowDto,
  type ShapeModelOption,
  type ShapeViewDto,
} from '@10db/contracts';
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

/** The efforts a model offers, as the models list gives them; none while the list loads or lacks it. */
function effortsOf(
  model: string | null,
  rows: ReadonlyMap<string, ModelRowDto>,
): readonly Effort[] {
  const row = model === null ? undefined : rows.get(model);
  const offered = new Set(row?.efforts.map((e) => e.effort));
  return Object.values(Effort).filter((e) => offered.has(e));
}

export interface ModelPickerProps {
  readonly view: ShapeViewDto;
}

/**
 * Chooses the model, and the effort, the conversation's next turn runs on; the effort lists only what the model offers. A change takes effect between turns, so
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
  const effort = view.shape.effort;
  // The default model is the one the Plan role picks, so its efforts are the ones on offer.
  const efforts = effortsOf(picked ?? view.models.default, rows);
  const send = (model: string | null, to: Effort | null) => {
    choose.mutate({ shapeId: view.shape.id, model, effort: to });
  };
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
          const model = value === DEFAULT_VALUE ? null : value;
          // The effort stays while the new model offers it, else the model's own default.
          const kept =
            effort !== null && effortsOf(model ?? view.models.default, rows).includes(effort);
          send(model, kept ? effort : null);
        }}
      />
      <Select
        aria-label="Effort"
        size="xs"
        w={120}
        data={[
          { value: DEFAULT_VALUE, label: 'Automatic' },
          ...efforts.map((e) => ({ value: e, label: e })),
        ]}
        value={effort !== null && efforts.includes(effort) ? effort : DEFAULT_VALUE}
        allowDeselect={false}
        disabled={busy}
        onChange={(value) => {
          if (value === null) return;
          send(picked, efforts.find((e) => e === value) ?? null);
        }}
      />
    </Group>
  );
}
