import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRepoFile } from './workspace';

const TauriConfig = z.object({
  productName: z.string(),
  identifier: z.string(),
});

const releaseConfig = TauriConfig.parse(
  JSON.parse(readRepoFile('apps/desktop/src-tauri/tauri.conf.json')),
);

describe('the desktop shell identity', () => {
  it('keeps the release bundle identifier and product name', () => {
    expect(releaseConfig.identifier).toBe('app.10db.desktop');
    expect(releaseConfig.productName).toBe('10db');
  });

  it('gives the dev shell its own identifier and product name so both can run at once', () => {
    const dev = TauriConfig.parse(
      JSON.parse(readRepoFile('apps/desktop/src-tauri/tauri.dev.conf.json')),
    );
    expect(dev.identifier).not.toBe(releaseConfig.identifier);
    expect(dev.productName).not.toBe(releaseConfig.productName);
  });

  it('applies the dev override only through dev:shell', () => {
    const manifest = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readRepoFile('apps/desktop/package.json')));
    expect(manifest.scripts['dev:shell']).toContain('--config src-tauri/tauri.dev.conf.json');
    expect(manifest.scripts['build'] ?? '').not.toContain('tauri.dev.conf.json');
  });
});
