import { Box, CloseButton, Group } from '@mantine/core';
import { useElementSize, useLocalStorage, useMergedRef } from '@mantine/hooks';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { escapeHasOwner, escapeIsTaken } from './use-shape-keys';
import {
  CHAT_MIN,
  DEFAULT_CHAT_SHARE,
  SIDEBAR_MIN,
  chatShareAfterDrag,
  splitLayout,
  type SplitLayout,
} from './split-layout';

const KEY_STEP_PX = 24;

function deserializeShare(value: string | undefined): number {
  try {
    const parsed: unknown = value === undefined ? null : JSON.parse(value);
    return typeof parsed === 'number' && parsed > 0 && parsed < 1 ? parsed : DEFAULT_CHAT_SHARE;
  } catch {
    return DEFAULT_CHAT_SHARE;
  }
}

export interface SplitPaneProps {
  /** Receives the layout, so the right pane can drop its summary line in the drawer layout. */
  readonly children: (layout: SplitLayout) => {
    readonly chat: ReactNode;
    readonly sidebar: ReactNode;
    readonly bar: ReactNode;
  };
  readonly drawerOpen: boolean;
  /** Closes the drawer (its Close button, Esc); the owner puts focus back on its toggle. */
  readonly onClose: () => void;
}

/**
 * The conversation beside the sidebar, split by a draggable divider that remembers its place. Under
 * 1100 px the sidebar is a drawer laid over the chat while `drawerOpen`.
 */
export function SplitPane({ children, drawerOpen, onClose }: SplitPaneProps) {
  const { ref: sizeRef, width } = useElementSize();
  const container = useRef<HTMLDivElement | null>(null);
  const ref = useMergedRef(sizeRef, container);
  const [share, setShare] = useLocalStorage<number>({
    key: 'tendb.shape.split',
    defaultValue: DEFAULT_CHAT_SHARE,
    getInitialValueInEffect: false,
    deserialize: deserializeShare,
  });
  const layout = splitLayout(width, share);
  const { chat, sidebar, bar } = children(layout);
  const dragging = useRef(false);
  const [chatPx, setChatPx] = useState<number | null>(null);

  // Esc closes the open drawer from anywhere on the screen, ahead of "Esc stops the turn" (capture
  // phase, default prevented), but leaves it to a modal, menu, open select or row editor.
  const closing = layout.mode === 'drawer' && drawerOpen;
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    if (!closing) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || escapeIsTaken(event) || escapeHasOwner(event)) return;
      event.preventDefault();
      latestClose.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [closing]);

  const shown = chatPx ?? (layout.mode === 'split' ? layout.chat : null);
  const move = (px: number): void => {
    const next = chatShareAfterDrag(px, width);
    setChatPx(null);
    setShare(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    if (!dragging.current) return;
    const left = container.current?.getBoundingClientRect().left ?? 0;
    setChatPx(Math.round(event.clientX - left));
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    const left = container.current?.getBoundingClientRect().left ?? 0;
    move(event.clientX - left);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const current = shown ?? Math.round(width * share);
    const next =
      event.key === 'ArrowLeft'
        ? current - KEY_STEP_PX
        : event.key === 'ArrowRight'
          ? current + KEY_STEP_PX
          : event.key === 'Home'
            ? CHAT_MIN
            : event.key === 'End'
              ? width - SIDEBAR_MIN
              : null;
    if (next === null) return;
    event.preventDefault();
    move(next);
  };

  const split = layout.mode === 'split';
  return (
    <Box
      ref={ref}
      flex="1 1 0px"
      mih={420}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: split ? 'row' : 'column',
        minWidth: 0,
      }}
    >
      {split ? null : bar}
      {/* The chat keeps this place in both layouts. A screen is drawn at width 0, which reads as
          split, and may turn out narrower a frame later; moving the chat would remount it, and a
          remount loses the draft, the failures and any send still on its way. */}
      <Box
        style={
          split
            ? { flex: 'none', minWidth: 0, width: shown ?? `${String(share * 100)}%` }
            : { flex: 1, minHeight: 0 }
        }
      >
        {chat}
      </Box>
      {split ? (
        // A focusable separator: its value is the chat's share of the width, in percent.
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the conversation"
          aria-valuemin={Math.round((CHAT_MIN / Math.max(width, 1)) * 100)}
          aria-valuemax={Math.round(((width - SIDEBAR_MIN) / Math.max(width, 1)) * 100)}
          aria-valuenow={Math.round((shown === null ? share : shown / Math.max(width, 1)) * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          style={{
            flex: 'none',
            width: 9,
            cursor: 'col-resize',
            touchAction: 'none',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <Box style={{ width: 1, background: 'var(--mantine-color-default-border)' }} />
        </Box>
      ) : null}
      {split ? <Box style={{ flex: 1, minWidth: 0 }}>{sidebar}</Box> : null}
      {!split && drawerOpen ? (
        <Box
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: `min(${String(SIDEBAR_MIN)}px, 100%)`,
            background: 'var(--mantine-color-body)',
            borderLeft: '1px solid var(--mantine-color-default-border)',
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* The drawer covers the bar's Proposed button, so it carries its own close. */}
          <Group justify="flex-end" px="xs" pt={6} style={{ flex: 'none' }}>
            <CloseButton aria-label="Close Proposed" size="sm" onClick={onClose} />
          </Group>
          <Box style={{ flex: 1, minHeight: 0 }}>{sidebar}</Box>
        </Box>
      ) : null}
    </Box>
  );
}
