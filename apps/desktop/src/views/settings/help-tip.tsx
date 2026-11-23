import { ActionIcon, HoverCard } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/**
 * A small info button beside a heading or label: hover or focus opens the long explanation, so the
 * page itself keeps to one short line.
 */
export function HelpTip({
  label,
  children,
}: {
  /** What the help is about; names the button for assistive tech. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <HoverCard width={340} shadow="md" position="top-start" withArrow openDelay={150}>
      <HoverCard.Target>
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`About ${label.toLowerCase()}`}
        >
          <IconInfoCircle size={14} aria-hidden />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown fz="sm">{children}</HoverCard.Dropdown>
    </HoverCard>
  );
}
