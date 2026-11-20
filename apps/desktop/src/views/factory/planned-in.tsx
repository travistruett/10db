import type { GoalId } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { useShapeOf } from '../../daemon/shape-queries';
import { useOpenSessionNotice } from '../sessions/open-session';

/** "Planned in <session>", a link that opens that session; nothing for a goal filed by hand. */
export function PlannedIn({ goalId }: { readonly goalId: GoalId }) {
  const of = useShapeOf({ goalId }).data;
  const { open, notice } = useOpenSessionNotice();
  if (of?.chatId == null) return null;
  const chatId = of.chatId;
  return (
    <Text size="sm" c="dimmed">
      {'Planned in '}
      <Anchor
        component="button"
        size="sm"
        onClick={() => {
          open(chatId);
        }}
      >
        {of.title ?? 'its session'}
      </Anchor>
      {notice}
    </Text>
  );
}
