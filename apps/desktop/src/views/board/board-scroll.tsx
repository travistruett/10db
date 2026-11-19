import { Box, Group, ScrollArea } from '@mantine/core';
import type { ReactNode } from 'react';

const SCROLLBAR = 12;
/** Room between the columns and the scrollbar under them. */
const GAP = 12;

/**
 * The board's columns in a horizontal scroll area. The scrollbar shows on hover in its own strip
 * below the columns, so it is not always on screen.
 */
export function BoardScroll({ children }: { readonly children: ReactNode }) {
  return (
    <Box pos="relative" flex={1} mih={0}>
      {/* The content wrapper is a table, so it is given the full height for the columns to fill. */}
      <ScrollArea
        h="100%"
        type="hover"
        scrollbars="x"
        scrollbarSize={SCROLLBAR}
        offsetScrollbars="x"
        styles={{ content: { height: '100%' } }}
      >
        <Group align="stretch" wrap="nowrap" gap="sm" h="100%" pb={GAP}>
          {children}
        </Group>
      </ScrollArea>
    </Box>
  );
}
