import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { canChooseFolder, chooseFolder } from './choose-folder';

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

/** The native panel is the boundary: Tauri's IPC answers the dialog plugin's `open` command. */
function panel(picked: string | null): unknown[] {
  const asked: unknown[] = [];
  mockIPC((command, args) => {
    if (command !== 'plugin:dialog|open') return undefined;
    asked.push(args);
    return picked;
  });
  return asked;
}

describe('chooseFolder', () => {
  it('returns the picked path', async () => {
    const asked = panel('/Users/me/widgets');
    await expect(chooseFolder()).resolves.toBe('/Users/me/widgets');
    expect(asked).toEqual([{ options: { directory: true, title: 'Choose a git checkout' } }]);
  });

  it('returns null on cancel', async () => {
    panel(null);
    await expect(chooseFolder()).resolves.toBeNull();
  });
});

describe('canChooseFolder', () => {
  it('is false outside Tauri', () => {
    expect(canChooseFolder()).toBe(false);
  });

  it('is true inside Tauri', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    expect(canChooseFolder()).toBe(true);
  });
});
