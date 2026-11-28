import { CloseButton, Group } from '@mantine/core';
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
 * the view beside it stays usable. A click outside leaves it open unless `closeOnClickOutside` is set;
 * then a press on the content beside it closes it, except on an element marked `data-keeps-drawer` (a
 * card that opens its own drawer) or anything outside the content (menus, dialogs, the sidebar). Esc
 * while focus is inside it or has fallen to the page, or its close button, closes it. It slides in over 150 ms, or appears at once
 * with reduced motion.
 */
export function SurfaceDrawer({
  opened,
  onClose,
  label,
  closeLabel = 'Close',
  widthPx,
  actions,
  closeOnClickOutside = false,
  showing,
  title,
  footer,
  children,
}: {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Names the drawer for assistive tech and heads it. */
  readonly label: string;
  /** The close button's name, when it says more than Close ("Close Plan"). */
  readonly closeLabel?: string;
  /** The width it asks for in a surface that has the room, where the default is half the surface. */
  readonly widthPx?: number;
  /** Icon buttons for what the drawer shows (links out, copy), on its top edge before the close button. */
  readonly actions?: ReactNode;
  /** A press on the content beside the drawer closes it. */
  readonly closeOnClickOutside?: boolean;
  /** What it shows, such as a record's id: when it changes while open, focus that was lost comes back in. */
  readonly showing?: string;
  /** A heading on the top edge, at the left; absent, the top edge holds only the buttons. */
  readonly title?: ReactNode;
  /** The drawer's actions, in a bar pinned to its bottom edge below the scrolling body. */
  readonly footer?: ReactNode;
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

  // A link inside that opens something else redraws the body under the focus, which falls to the page,
  // where Esc no longer reaches the drawer: focus comes back to the drawer.
  useEffect(() => {
    if (!opened || showing === undefined) return;
    if (!drawer.current?.contains(document.activeElement)) drawer.current?.focus();
  }, [opened, showing]);

  // A pick that saves at once can redraw the control under the focus, which then falls to the page: Esc there
  // still belongs to the open drawer. Focus anywhere else (a field, a menu, a dialog) keeps its own Esc.
  useEffect(() => {
    if (!opened) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused !== null && focused !== document.body) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [opened, onClose]);

  useEffect(() => {
    if (!opened || !closeOnClickOutside) return;
    const onPointerDown = (event: PointerEvent): void => {
      // The drawer sits in its layer, in the frame's drawer host, beside the view in the content box.
      const content = drawer.current?.parentElement?.parentElement?.parentElement;
      const target = event.target;
      if (!(target instanceof Element) || !content?.contains(target)) return;
      if (drawer.current?.contains(target) || target.closest('[data-keeps-drawer]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [opened, closeOnClickOutside, onClose]);

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
  const drawerWidth = full
    ? '100%'
    : widthPx === undefined
      ? `clamp(${String(MIN_PX)}px, 50%, ${String(MAX_PX)}px)`
      : `min(${String(widthPx)}px, 100%)`;
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
          {title === undefined ? null : <div className={classes['title']}>{title}</div>}
          {actions === undefined ? null : (
            <Group gap={4} wrap="nowrap">
              {actions}
            </Group>
          )}
          <CloseButton aria-label={closeLabel} onClick={onClose} />
        </div>
        <div className={classes['body']}>{children}</div>
        {footer === undefined ? null : <div className={classes['footer']}>{footer}</div>}
      </aside>
    </div>
  );
  // Outside a frame (a screen drawn alone) the drawer covers the nearest positioned ancestor instead.
  return drawerHost === null ? layer : createPortal(layer, drawerHost);
}
