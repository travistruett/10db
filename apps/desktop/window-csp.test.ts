import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import config from './vite.config';
import { IMG_SRC_DIRECTIVE, windowImgSrc } from './window-csp';

const TauriConf = z.object({ app: z.object({ security: z.object({ csp: z.string() }) }) });

function shellCsp(): string {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  return TauriConf.parse(raw).app.security.csp;
}

describe('the window img-src policy', () => {
  it("is the shell's own img-src directive", () => {
    expect(windowImgSrc(shellCsp())).toBe("img-src 'self' data:");
    expect(IMG_SRC_DIRECTIVE).toBe(windowImgSrc(shellCsp()));
  });

  it('refuses a policy with no img-src, rather than serve a page with none', () => {
    expect(() => windowImgSrc("default-src 'self'")).toThrow('img-src');
  });

  it('is sent by Vite with every page it serves, in dev and in preview', () => {
    const headers = { 'Content-Security-Policy': "img-src 'self' data:" };
    expect(config.server?.headers).toEqual(headers);
    expect(config.preview?.headers).toEqual(headers);
  });
});
