import { Box, Group, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFrameSlots } from './frame-slots';

/**
 * Draws a view's title and actions into the frame's title row while the view is mounted: the title,
 * an optional switcher beside it, a dim meta line, then the actions at the right. The row's own box and
 * the empty space between its parts drag the window; the controls a view puts in never do.
 */
export function TitleRow({
  title,
  meta,
  switcher,
  actions,
  lines = 1,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  /** A control beside the title that switches what the view shows. */
  readonly switcher?: ReactNode;
  readonly actions?: ReactNode;
  /** How many lines a long title takes before it is cut: two reads whole at a narrow width. */
  readonly lines?: 1 | 2;
}): ReactNode {
  const { titleHost } = useFrameSlots();
  if (titleHost === null) return null;
  return createPortal(
    <>
      {title === null || title === undefined ? null : (
        <Title
          order={1}
          fz={14}
          fw={600}
          lh="20px"
          c="var(--mantine-color-bright)"
          // A title that is a control (the session switcher) cuts its own text: a clamp here would cut
          // the control as well and add a second ellipsis after it.
          {...(typeof title === 'string' ? { title, lineClamp: lines } : { display: 'flex' })}
          style={{ minWidth: 0, flex: '0 1 auto' }}
          data-tauri-drag-region
        >
          {title}
        </Title>
      )}
      {switcher === undefined ? null : (
        <Box style={{ flex: '0 1 auto', minWidth: 0 }}>{switcher}</Box>
      )}
      {meta === undefined ? null : (
        <Box
          fz={12}
          c="dimmed"
          style={{
            minWidth: 0,
            // The meta line gives way before the title does.
            flexShrink: 100,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            // A badge or other element centres on the title; a plain string keeps its ellipsis.
            ...(typeof meta === 'string' ? {} : { display: 'flex', alignItems: 'center' }),
          }}
          data-tauri-drag-region
        >
          {meta}
        </Box>
      )}
      <Box style={{ flex: 1, alignSelf: 'stretch', minWidth: 8 }} data-tauri-drag-region />
      {actions === undefined ? null : (
        <Group gap={8} wrap="nowrap" style={{ flex: 'none' }}>
          {actions}
        </Group>
      )}
    </>,
    titleHost,
  );
}
