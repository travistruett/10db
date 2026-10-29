import { Box, HoverCard, VisuallyHidden } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface LabelWithHelpProps {
  readonly label: string;
  /** The help card's content. */
  readonly children: ReactNode;
}

/** A field label followed by an info icon whose hover or focus opens a help card. */
export function LabelWithHelp({ label, children }: LabelWithHelpProps) {
  return (
    <>
      {label}
      <HoverCard width={360} shadow="md" position="top-start" withArrow>
        <HoverCard.Target>
          <Box
            component="span"
            tabIndex={0}
            ml={6}
            c="dimmed"
            style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'help' }}
          >
            <IconInfoCircle size={14} aria-hidden />
            <VisuallyHidden>{`About ${label.toLowerCase()}`}</VisuallyHidden>
          </Box>
        </HoverCard.Target>
        <HoverCard.Dropdown>{children}</HoverCard.Dropdown>
      </HoverCard>
    </>
  );
}
