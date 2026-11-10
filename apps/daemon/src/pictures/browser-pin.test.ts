import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tempDir, type TempDir } from '../../test/fixtures';
import {
  ensurePinned,
  extractZipWithTar,
  pinnedExecutable,
  pinnedToolsRoot,
  removePinned,
  tarballIntegrity,
  type PinnedRelease,
} from '../environment';
import { BROWSER_PIN } from './browser-pin';

/** The browsers the installed `playwright-core` was built against, as its `browsers.json` lists them. */
const BrowsersJson = z.object({
  browsers: z.array(z.object({ name: z.string(), browserVersion: z.string().optional() })),
});

describe('the pinned browser', () => {
  it('is the headless shell the installed playwright-core drives', () => {
    const packageDir = dirname(
      createRequire(import.meta.url).resolve('playwright-core/package.json'),
    );
    const listed = BrowsersJson.parse(
      JSON.parse(readFileSync(join(packageDir, 'browsers.json'), 'utf8')),
    ).browsers.find((b) => b.name === 'chromium-headless-shell');
    expect(listed?.browserVersion).toBe(BROWSER_PIN.version);
    expect(BROWSER_PIN.tarballUrl).toContain(`/${BROWSER_PIN.version}/mac-arm64/`);
  });
});

describe('a pinned zip', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = tempDir('browser-pin');
  });
  afterEach(async () => {
    await removePinned(pinnedToolsRoot(join(dir.path, 'data')));
    dir.cleanup();
  });

  it('is unpacked from its top folder, executable bit kept, and runs', async () => {
    const src = join(dir.path, 'src', 'shell-mac-arm64');
    mkdirSync(join(src, 'resources'), { recursive: true });
    writeFileSync(join(src, 'shell'), '#!/bin/sh\necho shell 9.9\n');
    chmodSync(join(src, 'shell'), 0o755);
    writeFileSync(join(src, 'resources', 'a.pak'), 'pak');
    const zip = join(dir.path, 'shell.zip');
    execFileSync('/usr/bin/tar', [
      '--format',
      'zip',
      '-cf',
      zip,
      '-C',
      join(dir.path, 'src'),
      'shell-mac-arm64',
    ]);
    const pin: PinnedRelease = {
      tool: 'shell',
      label: 'A shell',
      version: '9.9',
      sha512: await tarballIntegrity(zip),
      tarballUrl: 'https://cdn.example.test/shell.zip',
      member: 'shell-mac-arm64',
      strip: 1,
      executable: 'shell',
    };
    const dataDir = join(dir.path, 'data');
    const exe = await ensurePinned(dataDir, pin, {
      download: (_url, to) => {
        copyFileSync(zip, to);
        return Promise.resolve();
      },
      extract: extractZipWithTar,
    });
    expect(exe).toBe(pinnedExecutable(dataDir, pin));
    expect(execFileSync(exe, [], { encoding: 'utf8' })).toBe('shell 9.9\n');
    expect(readFileSync(join(dirname(exe), 'resources', 'a.pak'), 'utf8')).toBe('pak');
  });
});
