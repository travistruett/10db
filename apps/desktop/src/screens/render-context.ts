import { createContext, use } from 'react';
import type { RenderParams } from './render-params';

/**
 * Set only in a frame the window draws a screen in (Shape spec §5.5); null in the app itself. The shell
 * and the selected project read it to draw the screen without chrome and without changing what the
 * builder has selected.
 */
export const RenderModeContext = createContext<RenderParams | null>(null);

export function useRenderMode(): RenderParams | null {
  return use(RenderModeContext);
}
