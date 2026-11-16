import { Box } from '@mantine/core';
import type { ReactNode } from 'react';

/** The widest a conversation's column is drawn, so a line of the reply stays readable. */
export const CONVERSATION_WIDTH = 720;

export interface ConversationLayoutProps {
  /** The region's name. */
  readonly label: string;
  /** The screen's bar across the whole space: a session's bar, a Plan's title, a page's name. */
  readonly header?: ReactNode;
  /** The list, which fills the height left over, and whatever sits right above it (the judge line). */
  readonly children: ReactNode;
  /** Under the list, in the column: the working line, what waits on the builder, and the composer. */
  readonly footer: ReactNode;
  /** Under the composer: what a new conversation offers (Plan's recent conversations). */
  readonly after?: ReactNode;
  /** A parent that is not a flex column gives its height this way. */
  readonly h?: string;
}

/**
 * Every conversation's frame (Sessions, Plan, the Workbench): the screen's bar on top, then one centred
 * column at most `CONVERSATION_WIDTH` wide, whose list takes the height left over and scrolls inside
 * itself, with what the footer holds pinned at its foot.
 */
export function ConversationLayout({
  label,
  header,
  children,
  footer,
  after,
  h,
}: ConversationLayoutProps) {
  return (
    <Box
      component="section"
      aria-label={label}
      h={h}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {header === undefined ? null : <Box style={{ flex: 'none' }}>{header}</Box>}
      <Box
        maw={CONVERSATION_WIDTH}
        w="100%"
        mx="auto"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {/* Each part is the column's own item, as the list sizes itself by `flex: 1` and the rest keep
            their height: another box between them would make the list's height a nested flex's. */}
        {children}
        {footer}
        {after}
      </Box>
    </Box>
  );
}
