import { open } from '@tauri-apps/plugin-dialog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canChooseFolder, chooseFolder } from './choose-folder';

// The native panel is the boundary: the plugin's `open` is the only thing replaced.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

afterEach(() => {
  vi.mocked(open).mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('chooseFolder', () => {
  it('returns the picked path', async () => {
    vi.mocked(open).mockResolvedValue('/Users/me/widgets');
    await expect(chooseFolder()).resolves.toBe('/Users/me/widgets');
    expect(open).toHaveBeenCalledWith({ directory: true, title: 'Choose a git checkout' });
  });

  it('returns null on cancel', async () => {
    vi.mocked(open).mockResolvedValue(null);
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
