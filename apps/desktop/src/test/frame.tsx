import { useState, type ReactNode } from 'react';
import { FrameSlotsContext } from '../shell/frame-slots';

/**
 * The frame's slots without the frame, for a component rendered alone: a title row and a panel box a
 * view's `TitleRow` and `Panel` draw into, and a layer for a drawer. Find them with `titleRowOf` and
 * `panelOf`.
 */
export function FrameSlots({ children }: { readonly children: ReactNode }) {
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  return (
    <FrameSlotsContext
      value={{ titleHost, panelHost, drawerHost, registerPanel: () => () => undefined }}
    >
      <div data-testid="title-row" data-title-row="" ref={setTitleHost} />
      <div data-testid="panel" ref={setPanelHost} />
      <div data-testid="drawer-layer" ref={setDrawerHost} />
      {children}
    </FrameSlotsContext>
  );
}

function slot(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`no ${testId}: render the component inside FrameSlots`);
  return element;
}

export const titleRowOf = (): HTMLElement => slot('title-row');
export const panelOf = (): HTMLElement => slot('panel');
