import { ModelTier, type ShapeModelOption, type ShapeViewDto } from '@10db/contracts';
import { Group, Select, Text, type ComboboxData } from '@mantine/core';
import { useChooseShapeModel } from '../../daemon/shape-queries';

/** The default option's value: Select cannot hold null as an option, and null is what it means. */
const DEFAULT_VALUE = '';

/** The groups, weakest tier first; a model the catalogue does not rank comes last. */
const TIER_ORDER: readonly (ModelTier | null)[] = [
  ModelTier.Fast,
  ModelTier.Balanced,
  ModelTier.Strongest,
  null,
];

function groupLabel(tier: ModelTier | null): string {
  return tier === null ? 'Unknown tier' : `${tier.charAt(0).toUpperCase()}${tier.slice(1)} models`;
}

/** The account's models as the Select takes them: one group per tier, in the daemon's order within it. */
function groupedByTier(offered: readonly ShapeModelOption[]): ComboboxData {
  return TIER_ORDER.flatMap((tier) => {
    const items = offered
      .filter((option) => option.tier === tier)
      .map((option) => ({ value: option.model, label: option.model }));
    return items.length === 0 ? [] : [{ group: groupLabel(tier), items }];
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
  const { offered } = view.models;
  if (offered.length === 0) return null;

  const busy = view.turn.running || view.turn.queued > 0 || choose.isPending;
  const picked = view.shape.model;
  const defaultLabel =
    view.models.default === null ? 'Default' : `Default (${view.models.default})`;
  // A pick the account no longer offers still shows, rather than reading as the default.
  const gone = picked !== null && !offered.some((option) => option.model === picked);
  const data: ComboboxData = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...(gone ? [{ value: picked, label: `${picked} (not offered)` }] : []),
    ...groupedByTier(offered),
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
