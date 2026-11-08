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
  it('opens GitHub, OpenAI sign-in pages and Artificial Analysis, and nothing else', () => {
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
});
