import { Effort, type ModelRowDto, type ShapeViewDto } from '@10db/contracts';
import { Group, Select } from '@mantine/core';
import { ModelPicker as ConversationModelPicker } from '../../conversation/model-picker';
import { useModels } from '../../daemon/model-queries';
import { useChooseShapeModel } from '../../daemon/shape-queries';

/** The default effort option's value: Select cannot hold null as an option. */
const DEFAULT_VALUE = '';

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

  const busy = view.turn.running || view.turn.queued > 0;
  const picked = view.shape.model;
  const rows = new Map((models.data ?? []).map((row) => [row.model, row]));
  const effort = view.shape.effort;
  // The default model is the one the Plan role picks, so its efforts are the ones on offer.
  const efforts = effortsOf(picked ?? view.models.default, rows);
  const send = (model: string | null, to: Effort | null) => {
    choose.mutate({ shapeId: view.shape.id, model, effort: to });
  };

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ConversationModelPicker
        offered={offered}
        default={view.models.default}
        picked={picked}
        busy={busy}
        pending={choose.isPending}
        error={choose.error?.message ?? null}
        onPick={(model) => {
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
        disabled={busy || choose.isPending}
        onChange={(value) => {
          if (value === null) return;
          send(picked, efforts.find((e) => e === value) ?? null);
        }}
      />
    </Group>
  );
}
