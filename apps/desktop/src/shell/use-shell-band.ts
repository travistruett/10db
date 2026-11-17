import { useSyncExternalStore } from 'react';
import { shellBand, type ShellBand } from './shell-layout';

function subscribe(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => {
    window.removeEventListener('resize', listener);
  };
}

/**
 * The window's width band. The window, not a container, because the frame decides what its content gets.
 * The band is the snapshot, so a resize within one band draws nothing again.
 */
export function useShellBand(): ShellBand {
  return useSyncExternalStore(subscribe, () => shellBand(window.innerWidth));
}
