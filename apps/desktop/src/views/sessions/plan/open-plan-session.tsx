import { Button } from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useShapeOf, type ShapeOfTarget } from '../../../daemon/shape-queries';
import { useOpenSessionNotice } from '../open-session';

// A goal's and a task's drawer offer Open Session, shown only when a plan's session made the goal or
// task; work filed by hand has none. It opens that session, brought back first if it was archived.

export function OpenPlanSession({ target }: { readonly target: ShapeOfTarget }) {
  const of = useShapeOf(target);
  const { open, notice } = useOpenSessionNotice();
  const chatId = of.data?.chatId ?? null;
  if (chatId === null) return null;
  return (
    <>
      <Button
        variant="subtle"
        size="compact-sm"
        leftSection={<IconMessages size={16} stroke={1.5} aria-hidden="true" />}
        style={{ alignSelf: 'flex-start' }}
        onClick={() => {
          open(chatId);
        }}
      >
        Open Session
      </Button>
      {notice}
    </>
  );
}
