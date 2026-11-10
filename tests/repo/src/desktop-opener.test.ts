import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRepoFile } from './workspace';

const Capability = z.object({
  permissions: z.array(
    z.union([
      z.string(),
      z.object({
        identifier: z.string(),
        allow: z.array(z.object({ url: z.string() })).optional(),
      }),
    ]),
  ),
});

describe("the desktop app's opener", () => {
  it('opens GitHub, OpenAI sign-in pages, and Artificial Analysis, and nothing else', () => {
    const capability = Capability.parse(
      JSON.parse(readRepoFile('apps/desktop/src-tauri/capabilities/default.json')),
    );
    const opener = capability.permissions.find(
      (p) => typeof p === 'object' && p.identifier === 'opener:allow-open-url',
    );
    expect(typeof opener === 'object' ? opener.allow?.map((a) => a.url) : null).toEqual([
      'https://github.com/*',
      'https://auth.openai.com/*',
      // The credit Artificial Analysis's terms ask for links its site beside every view of its scores.
      'https://artificialanalysis.ai/*',
    ]);
  });

  it('names no http address; loopback pages open through the shell command that parses them', () => {
    const capability = readRepoFile('apps/desktop/src-tauri/capabilities/default.json');
    const urls = Capability.parse(JSON.parse(capability)).permissions.flatMap((p) =>
      typeof p === 'object' ? (p.allow ?? []).map((a) => a.url) : [],
    );
    expect(urls.filter((url) => !url.startsWith('https://'))).toEqual([]);
    expect(readRepoFile('apps/desktop/src-tauri/src/lib.rs')).toMatch(
      /generate_handler!\[[^\]]*open_app_page/,
    );
  });
});

describe("the desktop app's window", () => {
  it('may be shown, unminimized and focused, which a click on a ready notification does', () => {
    const capability = Capability.parse(
      JSON.parse(readRepoFile('apps/desktop/src-tauri/capabilities/default.json')),
    );
    expect(capability.permissions).toEqual(
      expect.arrayContaining([
        'core:window:allow-show',
        'core:window:allow-unminimize',
        'core:window:allow-set-focus',
      ]),
    );
  });
});
