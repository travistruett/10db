import { createContext, useContext } from 'react';

/** How the rail draws its rows, shared with the parts inside it (the project row, the status controls). */
export interface RailMode {
  /** Rows carry their labels (200 px); otherwise they are icons only (76 px). */
  readonly labels: boolean;
  /** What a click on the open section's own row does, when the section has a panel to show or hide. */
  readonly onActiveClick: (() => void) | null;
}

export const RailModeContext = createContext<RailMode>({ labels: false, onActiveClick: null });

export function useRailMode(): RailMode {
  return useContext(RailModeContext);
}
