import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri';

/** True when the native folder panel exists: only inside the desktop app, not in a browser. */
export function canChooseFolder(): boolean {
  return isTauri();
}

/** Opens the native folder panel; the picked path, or null when the builder cancels. */
export function chooseFolder(): Promise<string | null> {
  return open({ directory: true, title: 'Choose a git checkout' });
}
