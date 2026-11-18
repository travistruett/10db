import { CloseButton, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFrameSlots } from './frame-slots';
import classes from './surface-drawer.module.css';

/** The drawer's smallest and largest width, and the share of the surface it takes between them. */
const MIN_PX = 480;
const MAX_PX = 760;
/** A surface narrower than this gives the drawer all of its width. */
const FULL_UNDER_PX = 640;

/**
 * A slide-out drawer from the content surface's right edge: half the surface (480 to 760 px, all of it
 * when the surface is under 640), in the surface's own tone with a hairline left edge. It is not modal:
 * the view beside it stays usable, and a click outside leaves it open. Esc while focus is inside it, or
 * its close button, closes it. It slides in over 150 ms, or appears at once with reduced motion.
 */
export function SurfaceDrawer({
  opened,
  onClose,
  label,
  children,
}: {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Names the drawer for assistive tech and heads it. */
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  const { drawerHost } = useFrameSlots();
  const { ref: layerRef, width } = useElementSize();
  const drawer = useRef<HTMLElement | null>(null);

  // Focus moves in, so Esc works at once, and goes back to where it was when the drawer closes.
  useEffect(() => {
    if (!opened) return;
    const before = document.activeElement;
    drawer.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
    // The drawer's element is drawn again once the frame's layer is there, so focus follows it.
  }, [opened, drawerHost]);

  if (!opened) return null;

  // Esc from a dialog the drawer opened (a confirm, a picture) belongs to that dialog: it sits outside
  // the drawer in the page, though React lets its events bubble through.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.stopPropagation();
    onClose();
  };

  const full = width > 0 && width < FULL_UNDER_PX;
  const drawerWidth = full ? '100%' : `clamp(${String(MIN_PX)}px, 50%, ${String(MAX_PX)}px)`;
  const layer = (
    <div ref={layerRef} className={classes['layer']}>
      {/* A dialog's own key handling: Esc closes it, while focus is inside. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <aside
        ref={drawer}
        className={classes['drawer']}
        style={{ width: drawerWidth }}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={classes['head']}>
          <Text fw={600} size="sm">
            {label}
          </Text>
          <CloseButton aria-label="Close" onClick={onClose} />
        </div>
        <div className={classes['body']}>{children}</div>
      </aside>
    </div>
  );
  // Outside a frame (a screen drawn alone) the drawer covers the nearest positioned ancestor instead.
  return drawerHost === null ? layer : createPortal(layer, drawerHost);
}
