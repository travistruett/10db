import { createContext, useContext } from 'react';
import type { RailSection } from './rail-items';

/**
 * The places the frame lets a view draw into. A host is null until the frame has mounted it, so a view
 * draws nothing for that first pass.
 */
export interface FrameSlots {
  /** The title row's box, at the top of the content column beside the traffic lights. */
  readonly titleHost: HTMLElement | null;
  /** The panel's box: a column, or a sheet over the content, depending on the width. */
  readonly panelHost: HTMLElement | null;
  /** The layer over the content column that a drawer slides in on. */
  readonly drawerHost: HTMLElement | null;
  /** Whether the frame draws the panel now: a column, or the sheet while it is open. */
  readonly panelShown: boolean;
  /** Hides the panel when it is a column the builder can fold; null when it is not (a sheet, or none). */
  readonly hidePanel: (() => void) | null;
  /** Shows the panel: unfolds the column, or opens the sheet; does nothing when it is already shown or there is none. */
  readonly showPanel: () => void;
  /** Closes whatever sheet is open over the content, such as the panel's; does nothing when none is. */
  readonly closeSheet: () => void;
  /** Tells the frame a section has a panel while the caller stays mounted; returns the way to withdraw it. */
  readonly registerPanel: (section: RailSection) => () => void;
}

export const FrameSlotsContext = createContext<FrameSlots | null>(null);

/** The frame's slots, or the empty set outside a frame (a view rendered alone draws no title or panel). */
export function useFrameSlots(): FrameSlots {
  return (
    useContext(FrameSlotsContext) ?? {
      titleHost: null,
      panelHost: null,
      drawerHost: null,
      panelShown: false,
      hidePanel: null,
      showPanel: () => undefined,
      closeSheet: () => undefined,
      registerPanel: () => () => undefined,
    }
  );
}
