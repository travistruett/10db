import type { GoalId } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { useShapeOf } from '../../daemon/shape-queries';
import { useOpenSession } from '../sessions/open-session';

/** "Planned in <session>", a link that opens that session; nothing for a goal filed by hand. */
export function PlannedIn({ goalId }: { readonly goalId: GoalId }) {
  const of = useShapeOf({ goalId }).data;
  const openSession = useOpenSession();
  if (of?.chatId == null) return null;
  const chatId = of.chatId;
  return (
    <Text size="sm" c="dimmed">
      {'Planned in '}
      <Anchor
        component="button"
        size="sm"
        onClick={() => {
          void openSession(chatId);
        }}
      >
        {of.title ?? 'its session'}
      </Anchor>
    </Text>
  );
}
