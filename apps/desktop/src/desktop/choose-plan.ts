import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri';

/** True when the native file panel exists: only inside the desktop app, not in a browser. */
export function canChoosePlan(): boolean {
  return isTauri();
}

/** Opens the native file panel for a Markdown plan; the picked path, or null when the builder cancels. */
export function choosePlan(): Promise<string | null> {
  return open({
    directory: false,
    multiple: false,
    title: 'Choose a plan to adopt',
    filters: [{ name: 'Plan', extensions: ['md'] }],
  });
}
