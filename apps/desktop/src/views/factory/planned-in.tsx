import type { GoalId } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useShapeOf } from '../../daemon/shape-queries';

/** "Planned in <Plan>", a link to that Plan's record; nothing for a goal filed by hand. */
export function PlannedIn({ goalId }: { readonly goalId: GoalId }) {
  const of = useShapeOf({ goalId }).data;
  const navigate = useNavigate();
  if (of?.shapeId == null) return null;
  const shapeId = of.shapeId;
  return (
    <Text size="sm" c="dimmed">
      {'Planned in '}
      <Anchor
        component="button"
        size="sm"
        onClick={() => {
          void navigate({ to: '/shape/$shapeId/record', params: { shapeId } });
        }}
      >
        {of.title ?? 'its Plan'}
      </Anchor>
    </Text>
  );
}
