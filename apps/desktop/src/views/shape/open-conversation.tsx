import type { ShapeId } from '@10db/contracts';
import { Button } from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useShapeOf, type ShapeOfTarget } from '../../daemon/shape-queries';

// Shape spec §12: a goal's and a task's drawer gain Open conversation, shown only when a conversation
// made the goal or task; work filed by hand has none. It opens that conversation in the Shape view,
// where the builder can re-plan: the reopened session proposes additions, changes and removals.

export function OpenConversation({
  target,
  onOpen,
}: {
  readonly target: ShapeOfTarget;
  readonly onOpen: (shapeId: ShapeId) => void;
}) {
  const of = useShapeOf(target);
  const shapeId = of.data?.shapeId ?? null;
  if (shapeId === null) return null;
  return (
    <Button
      variant="subtle"
      size="compact-sm"
      leftSection={<IconMessages size={16} stroke={1.5} aria-hidden="true" />}
      style={{ alignSelf: 'flex-start' }}
      onClick={() => {
        onOpen(shapeId);
      }}
    >
      Open conversation
    </Button>
  );
}
