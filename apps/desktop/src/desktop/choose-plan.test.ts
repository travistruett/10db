import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { canChoosePlan, choosePlan } from './choose-plan';

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

describe('choosePlan', () => {
  it('asks for one Markdown file and returns its path', async () => {
    const asked = panel('/Users/me/plans/importer.md');
    await expect(choosePlan()).resolves.toBe('/Users/me/plans/importer.md');
    expect(asked).toEqual([
      {
        options: {
          directory: false,
          multiple: false,
          title: 'Choose a plan to adopt',
          filters: [{ name: 'Plan', extensions: ['md'] }],
        },
      },
    ]);
  });

  it('returns null on cancel', async () => {
    panel(null);
    await expect(choosePlan()).resolves.toBeNull();
  });
});

describe('canChoosePlan', () => {
  it('is false outside Tauri and true inside it', () => {
    expect(canChoosePlan()).toBe(false);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    expect(canChoosePlan()).toBe(true);
  });
});
