import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFrameSlots } from './frame-slots';
import type { RailSection } from './rail-items';

/**
 * A section's list, drawn in the frame's panel column (or the sheet that stands in for it when the
 * window is narrow) while the view that renders this is mounted. The frame knows the section has a panel
 * for as long as this stays mounted.
 */
export function Panel({
  section,
  children,
}: {
  readonly section: RailSection;
  readonly children: ReactNode;
}): ReactNode {
  const { panelHost, registerPanel } = useFrameSlots();
  useEffect(() => registerPanel(section), [registerPanel, section]);
  return panelHost === null ? null : createPortal(children, panelHost);
}
