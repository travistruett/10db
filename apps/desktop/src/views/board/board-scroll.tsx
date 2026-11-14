import { Box, Group, ScrollArea } from '@mantine/core';
import type { ReactNode } from 'react';
import { useHiddenEdges } from '../../shell/use-hidden-edges';
import { EdgeFade } from './edge-fade';

const SCROLLBAR = 12;
/** Room between the columns and the scrollbar under them. */
const GAP = 12;
const FADE = { color: 'var(--mantine-color-body)', depth: 56, inset: { end: SCROLLBAR + GAP } };

/**
 * The board's columns in a horizontal scroll area. The scrollbar shows on hover in its own strip
 * below the columns, and an edge fades while columns are hidden past it, so the board says there is
 * more without a scrollbar always on screen.
 */
export function BoardScroll({ children }: { readonly children: ReactNode }) {
  const { ref, edges, onScroll } = useHiddenEdges();
  return (
    <Box pos="relative" flex={1} mih={0}>
      {/* The content wrapper is a table, so it is given the full height for the columns to fill. */}
      <ScrollArea
        h="100%"
        type="hover"
        scrollbars="x"
        scrollbarSize={SCROLLBAR}
        offsetScrollbars="x"
        viewportRef={ref}
        onScrollPositionChange={onScroll}
        styles={{ content: { height: '100%' } }}
      >
        <Group align="stretch" wrap="nowrap" gap="sm" h="100%" pb={GAP}>
          {children}
        </Group>
      </ScrollArea>
      <EdgeFade side="left" shown={edges.left} {...FADE} />
      <EdgeFade side="right" shown={edges.right} {...FADE} />
    </Box>
  );
}
