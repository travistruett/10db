import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// The installed window runs under the CSP in src-tauri/tauri.conf.json. `pnpm dev` and `pnpm dev:factory`
// serve the same UI from Vite, which has no CSP of its own, so what the shape view draws (Mermaid's SVG
// in the live document) would be held safe only by the checks in views/shape/attachments/safe-render.ts.
// Vite sends the window's img-src with its pages, so a load those checks miss (`new Image()`, a
// stylesheet url()) is stopped in the browser modes too. Only img-src: the dev server needs inline
// scripts for hot reload and its own websocket, which the rest of the window's policy would refuse.

const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

/** The `img-src` directive of a CSP string. Throws when it has none, so a page is never served without. */
export function windowImgSrc(csp: string): string {
  const found = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => /^img-src(\s|$)/.test(directive));
  if (found === undefined) throw new Error('The window CSP has no img-src directive');
  return found;
}

/** The window's img-src, read from the shell's config so the two cannot drift. */
export const IMG_SRC_DIRECTIVE = windowImgSrc(
  TauriConf.parse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, 'src-tauri/tauri.conf.json'), 'utf8')),
  ).app.security.csp,
);
