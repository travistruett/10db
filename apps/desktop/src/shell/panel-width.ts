import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, PANEL_WIDTH } from './shell-layout';
import { storedWidth } from './stored-width';

// How wide the builder dragged the section's panel, one width for every section, kept across restarts.

const panelWidth = storedWidth({
  key: 'tendb.shell.panelWidth',
  min: PANEL_MIN_WIDTH,
  max: PANEL_MAX_WIDTH,
  initial: PANEL_WIDTH,
});

/** The panel's width in pixels, and how to set it (clamped to the panel's range). */
export function usePanelWidth(): {
  readonly width: number;
  readonly setWidth: (px: number) => void;
} {
  return panelWidth.use();
}

export { px } from './stored-width';
