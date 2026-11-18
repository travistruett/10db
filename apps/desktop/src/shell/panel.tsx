import { ActionIcon, Text, Tooltip } from '@mantine/core';
import { IconLayoutSidebarLeftCollapse } from '@tabler/icons-react';
import { useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFrameSlots } from './frame-slots';
import type { RailSection } from './rail-items';
import classes from './panel.module.css';

/**
 * A section's list, drawn in the frame's panel column (or the sheet that stands in for it when the
 * window is narrow) while the view that renders this is mounted. The frame knows the section has a panel
 * for as long as this stays mounted. The panel's head is the sidebar's top row: the section's name, its
 * controls and, while the panel is a column, a button that folds it.
 */
export function Panel({
  section,
  title,
  controls,
  children,
}: {
  readonly section: RailSection;
  readonly title: string;
  /** Buttons at the head's right end, before the fold button. */
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { panelHost, hidePanel, registerPanel } = useFrameSlots();
  // Before paint, so the column is there in the first frame and the content does not jump across.
  useLayoutEffect(() => registerPanel(section), [registerPanel, section]);
  if (panelHost === null) return null;
  return createPortal(
    <>
      <div className={classes['head']} data-tauri-drag-region>
        <Text fz={14} fw={600} c="var(--mantine-color-bright)" className={classes['title']}>
          {title}
        </Text>
        {controls}
        {hidePanel === null ? null : (
          <Tooltip label="Hide the panel ⌘\" position="bottom" openDelay={300}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={28}
              aria-label="Hide the panel"
              onClick={hidePanel}
            >
              <IconLayoutSidebarLeftCollapse size={16} stroke={1.6} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
      <div className={classes['body']}>{children}</div>
    </>,
    panelHost,
  );
}
