import { useState, type ReactNode } from 'react';
import { FrameSlotsContext } from '../shell/frame-slots';

/**
 * The frame's slots without the frame, for a component rendered alone: a title row and a panel box a
 * view's `TitleRow` and `Panel` draw into, and a layer for a drawer.
 */
export function FrameSlots({
  children,
  panelShown = true,
}: {
  readonly children: ReactNode;
  /** Whether the frame draws the panel; false is a folded or closed one. */
  readonly panelShown?: boolean;
}) {
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  return (
    <FrameSlotsContext
      value={{
        titleHost,
        panelHost,
        drawerHost,
        panelShown,
        showPanel: () => undefined,
        closeSheet: () => undefined,
        registerPanel: () => () => undefined,
      }}
    >
      <div data-testid="title-row" data-title-row="" ref={setTitleHost} />
      <div data-testid="panel" ref={setPanelHost} />
      <div data-testid="drawer-layer" ref={setDrawerHost} />
      {children}
    </FrameSlotsContext>
  );
}
