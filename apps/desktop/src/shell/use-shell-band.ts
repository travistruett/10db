import { useSyncExternalStore } from 'react';
import { shellBand, type ShellBand } from './shell-layout';

function subscribe(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => {
    window.removeEventListener('resize', listener);
  };
}

/** The window's width band. The window, not a container, because the frame decides what its content gets. */
export function useShellBand(): ShellBand {
  return shellBand(useSyncExternalStore(subscribe, () => window.innerWidth));
}
