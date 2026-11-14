import { Box } from '@mantine/core';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// The header's one place a view may draw into, between the traffic lights and the status icons. The shell
// keeps `data-tauri-drag-region` on its own boxes, the slot's included, and never on what a view puts in
// it: a click on a view's tab is a click, and a click on the slot's empty part drags the window.

interface Slot {
  readonly element: HTMLElement | null;
  readonly setElement: (element: HTMLElement | null) => void;
}

const HeaderSlotContext = createContext<Slot | null>(null);

export function HeaderSlotProvider({ children }: { readonly children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  return <HeaderSlotContext value={{ element, setElement }}>{children}</HeaderSlotContext>;
}

/** Where the slot's content lands; the shell draws it once, in the header. */
export function HeaderSlotTarget() {
  const slot = useContext(HeaderSlotContext);
  return (
    <Box
      ref={slot?.setElement}
      data-tauri-drag-region
      data-header-slot
      style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}
    />
  );
}

/** Puts `children` in the header's slot while the view that renders this is mounted. */
export function HeaderSlot({ children }: { readonly children: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  return slot?.element == null ? null : createPortal(children, slot.element);
}
