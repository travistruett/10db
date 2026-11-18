import { createContext, useContext } from 'react';
import type { RailSection } from './rail-items';

/**
 * The places the frame lets a view draw into. A host is null until the frame has mounted it, so a view
 * draws nothing for that first pass.
 */
export interface FrameSlots {
  /** The title row's box, on the frame beside the traffic lights. */
  readonly titleHost: HTMLElement | null;
  /** The panel's box: a column, or a sheet over the content, depending on the width. */
  readonly panelHost: HTMLElement | null;
  /** The layer over the content surface that a drawer slides in on. */
  readonly drawerHost: HTMLElement | null;
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
      registerPanel: () => () => undefined,
    }
  );
}
