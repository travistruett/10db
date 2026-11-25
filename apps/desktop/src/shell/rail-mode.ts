import { createContext, useContext } from 'react';

/** How the rail draws its rows, shared with the parts inside it (the project row, the download status). */
export interface RailMode {
  /** Rows carry their labels (200 px); otherwise they are icons only (60 px). */
  readonly labels: boolean;
}

export const RailModeContext = createContext<RailMode>({ labels: false });

export function useRailMode(): RailMode {
  return useContext(RailModeContext);
}
