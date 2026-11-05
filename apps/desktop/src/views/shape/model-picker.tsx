import type { ShapeViewDto } from '@10db/contracts';
import { Group, Select, Text } from '@mantine/core';
import { useChooseShapeModel } from '../../daemon/shape-queries';

/** The default option's value: Select cannot hold null as an option, and null is what it means. */
const DEFAULT_VALUE = '';

/** A model alias as the builder reads it: `fable` is Fable. */
function modelLabel(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
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
  const { offered } = view.models;
  if (offered.length === 0) return null;

  const busy = view.turn.running || view.turn.queued > 0 || choose.isPending;
  const picked = view.shape.model;
  const defaultLabel =
    view.models.default === null ? 'Default' : `Default (${modelLabel(view.models.default)})`;
  // A pick the account no longer offers still shows, rather than reading as the default.
  const aliases = picked === null || offered.includes(picked) ? offered : [picked, ...offered];
  const data = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...aliases.map((alias) => ({ value: alias, label: modelLabel(alias) })),
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
        w={170}
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
