import type { ShapeId } from '@10db/contracts';
import { UnstyledButton } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** A link that opens a conversation: a plain anchor the router navigates, so the id is typed at this one call site. */
export function ConversationLink({
  shapeId,
  current = false,
  onOpen,
  children,
}: {
  readonly shapeId: ShapeId;
  readonly current?: boolean;
  /** Told when the link is followed, so a popover can close. */
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <UnstyledButton
      component="a"
      href={`/shape/${shapeId}`}
      aria-current={current ? 'page' : undefined}
      display="block"
      w="100%"
      px="xs"
      py={6}
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
      onClick={(event: React.MouseEvent) => {
        event.preventDefault();
        onOpen?.();
        void navigate({ to: '/shape/$shapeId', params: { shapeId } });
      }}
    >
      {children}
    </UnstyledButton>
  );
}
