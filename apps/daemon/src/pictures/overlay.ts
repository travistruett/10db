// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §12: a dev server's error
// overlay over the page is a broken preview. Playwright's CSS selectors pierce open shadow roots, where
// both overlays live.

/** How a dev server shows a page that does not build: what marks it, and where its text is. */
export interface OverlaySelector {
  readonly framework: string;
  /** Present only while the overlay is up. */
  readonly selector: string;
  /** The overlay's own text. */
  readonly text: string;
}

/**
 * The overlays recognised, per framework. Next (13 and later): the error dialog a build error opens by
 * itself; the dev indicator and its issue badge, in the same portal, are not a broken page. Vite: its
 * error overlay element. Any other dev server shows no overlay 10db knows: only a failed load counts.
 */
export const OVERLAY_SELECTORS: readonly OverlaySelector[] = [
  {
    framework: 'Next',
    selector: 'nextjs-portal [data-nextjs-dialog]',
    text: 'nextjs-portal [data-nextjs-dialog]',
  },
  { framework: 'Vite', selector: 'vite-error-overlay', text: 'vite-error-overlay .window' },
];

/** How much of an overlay's text a shot keeps. */
export const OVERLAY_MAX_BYTES = 4096;

/** The overlay's text, trimmed and cut to `OVERLAY_MAX_BYTES` of UTF-8, ending in `…` when cut. */
export function capOverlayText(raw: string): string {
  const text = raw.trim();
  if (Buffer.byteLength(text, 'utf8') <= OVERLAY_MAX_BYTES) return text;
  const room = OVERLAY_MAX_BYTES - Buffer.byteLength('…', 'utf8');
  let kept = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > room) break;
    kept += char;
    bytes += size;
  }
  return `${kept}…`;
}
