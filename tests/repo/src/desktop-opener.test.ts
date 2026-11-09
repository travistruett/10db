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

const LOOPBACK_HTTP_PATTERNS = [
  'http://localhost/*',
  'http://localhost:*',
  'http://127.0.0.1/*',
  'http://127.0.0.1:*',
  'http://[[]::1]/*',
  'http://[[]::1]:*',
  'http://*.localhost/*',
  'http://*.localhost:*',
];

describe("the desktop app's opener", () => {
  it('opens GitHub, OpenAI sign-in pages, Artificial Analysis and loopback http, and nothing else', () => {
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
      ...LOOPBACK_HTTP_PATTERNS,
    ]);
  });

  it('names http only for loopback hosts', () => {
    const capability = Capability.parse(
      JSON.parse(readRepoFile('apps/desktop/src-tauri/capabilities/default.json')),
    );
    const urls = capability.permissions.flatMap((p) =>
      typeof p === 'object' ? (p.allow ?? []).map((a) => a.url) : [],
    );
    const http = urls.filter((url) => !url.startsWith('https://'));
    expect(http.length).toBeGreaterThan(0);
    for (const url of http) {
      // A glob: `[[]` is a literal `[`, `*` in the host position only as a leading label before `.localhost`.
      expect(url, url).toMatch(
        /^http:\/\/(localhost|127\.0\.0\.1|\[\[\]::1\]|\*\.localhost)(:\*|\/\*)$/,
      );
    }
  });
});
