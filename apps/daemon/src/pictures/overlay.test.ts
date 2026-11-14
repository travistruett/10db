import { describe, expect, it } from 'vitest';
import { capOverlayText, OVERLAY_MAX_BYTES, OVERLAY_SELECTORS } from './overlay';

describe('OVERLAY_SELECTORS', () => {
  const selectors = OVERLAY_SELECTORS.map((o) => o.selector);
  it.each<[string, string, boolean]>([
    [
      "Next's error dialog, which a build error opens by itself",
      'nextjs-portal [data-nextjs-dialog]',
      true,
    ],
    [
      "Next's portal alone, which also holds the dev indicator and its issue badge",
      'nextjs-portal',
      false,
    ],
    ["Vite's error overlay", 'vite-error-overlay', true],
  ])('%s', (_name, selector, broken) => {
    expect(selectors.includes(selector)).toBe(broken);
  });

  it('reads each overlay’s text from inside the overlay', () => {
    for (const overlay of OVERLAY_SELECTORS) {
      expect(overlay.text.startsWith(overlay.selector)).toBe(true);
    }
  });
});

describe('capOverlayText', () => {
  it.each<[string, string, string]>([
    ['keeps a short text, trimmed', '  Module not found  \n', 'Module not found'],
    ['keeps an empty one empty', '   ', ''],
  ])('%s', (_name, raw, expected) => {
    expect(capOverlayText(raw)).toBe(expected);
  });

  it('cuts a long text to at most 4 KB, never inside a character', () => {
    const capped = capOverlayText('é'.repeat(5000));
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(OVERLAY_MAX_BYTES);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.replace('…', '')).toMatch(/^é+$/);
  });
});
