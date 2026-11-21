// Shape spec §10.3. A mock-up is HTML the session wrote, so it is drawn with no script, no network and
// no frame, by the window's sandboxed iframe and by the pictures browser alike: both read this one copy.

/** The mockup document's policy: no script, no network, no frame; inline styles and data images only. */
export const MOCKUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** The document for a mockup: its policy first, before anything the mockup holds. */
export function mockupDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${MOCKUP_CSP}"><meta charset="utf-8"></head><body>${html}</body></html>`;
}
