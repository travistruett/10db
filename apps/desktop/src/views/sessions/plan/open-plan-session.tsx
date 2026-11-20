import type { ChatId } from '@10db/contracts';
import { Button } from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useShapeOf, type ShapeOfTarget } from '../../../daemon/shape-queries';

// A goal's and a task's drawer offer Open Session, shown only when a plan's session made the goal or
// task; work filed by hand has none. It opens that session, brought back first if it was archived.

export function OpenPlanSession({
  target,
  onOpen,
}: {
  readonly target: ShapeOfTarget;
  readonly onOpen: (chatId: ChatId) => void;
}) {
  const of = useShapeOf(target);
  const chatId = of.data?.chatId ?? null;
  if (chatId === null) return null;
  return (
    <Button
      variant="subtle"
      size="compact-sm"
      leftSection={<IconMessages size={16} stroke={1.5} aria-hidden="true" />}
      style={{ alignSelf: 'flex-start' }}
      onClick={() => {
        onOpen(chatId);
      }}
    >
      Open Session
    </Button>
  );
}
