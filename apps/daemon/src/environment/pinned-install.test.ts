import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeTarball, pinForTarball, servingTarball } from '../../test/pinned-tarball';
import { tempDir } from '../../test/fixtures';
import {
  ensurePinned,
  pinnedDir,
  pinnedToolsRoot,
  PinnedToolError,
  removePinned,
  verifyPinned,
} from './pinned-install';

let dir: { path: string; cleanup(): void };
let dataDir: string;
beforeEach(() => {
  dir = tempDir('pinned-install');
  dataDir = join(dir.path, 'data');
});
afterEach(async () => {
  await removePinned(pinnedToolsRoot(dataDir));
  dir.cleanup();
});

const buildTarball = (name: string, output: string): string =>
  buildClaudeTarball(dir.path, name, output);
const pinFor = pinForTarball;
const serving = servingTarball;

describe('the pinned copy', () => {
  it('is read-only: a command run as the same user cannot write the file or its folder', async () => {
    const tarball = buildTarball('readonly', '1.2.3');
    const pin = await pinFor(tarball);
    const exe = await ensurePinned(dataDir, pin, serving(tarball));
    expect(() => {
      writeFileSync(exe, '#!/bin/sh\necho owned\n');
    }).toThrow(/EACCES/);
    expect(() => {
      writeFileSync(join(pinnedDir(dataDir, pin), 'extra'), 'x');
    }).toThrow(/EACCES/);
  });

  it('refuses a download whose checksum is not the recorded one, and installs nothing', async () => {
    const tarball = buildTarball('real', '1.2.3');
    const other = buildTarball('swapped', 'evil');
    const pin = await pinFor(tarball);
    const failure = await ensurePinned(dataDir, pin, serving(other)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PinnedToolError);
    expect((failure as PinnedToolError).message).toContain('Claude Code 1.2.3 was refused');
    expect((failure as PinnedToolError).message).toContain(pin.sha512);
    expect((failure as PinnedToolError).message).toContain('nothing was installed');
    expect(existsSync(pinnedDir(dataDir, pin))).toBe(false);
    expect(readdirSync(pinnedToolsRoot(dataDir))).toEqual([]);
  });

  it('is refused once a file in it no longer hashes to what was installed', async () => {
    const tarball = buildTarball('tampered', '1.2.3');
    const pin = await pinFor(tarball);
    const exe = await ensurePinned(dataDir, pin, serving(tarball));
    chmodSync(pinnedDir(dataDir, pin), 0o755);
    chmodSync(exe, 0o755);
    writeFileSync(exe, '#!/bin/sh\necho owned\n');
    chmodSync(exe, 0o555);
    chmodSync(pinnedDir(dataDir, pin), 0o555);
    const failure = await verifyPinned(dataDir, pin).catch((e: unknown) => e);
    expect((failure as PinnedToolError).message).toMatch(
      /^Claude Code 1\.2\.3 was refused: the files in .* no longer match the checksum recorded/,
    );
  });

  it('is refused when it was installed from a download other than the recorded one', async () => {
    const tarball = buildTarball('rebuilt', '1.2.3');
    const pin = await pinFor(tarball);
    await ensurePinned(dataDir, pin, serving(tarball));
    const moved = { ...pin, sha512: `sha512-${'A'.repeat(86)}==` };
    const failure = await verifyPinned(dataDir, moved).catch((e: unknown) => e);
    expect((failure as PinnedToolError).message).toContain(
      `its recorded checksum is ${moved.sha512}`,
    );
  });

  it('is refused when a group or others can write to it', async () => {
    const tarball = buildTarball('loose', '1.2.3');
    const pin = await pinFor(tarball);
    await ensurePinned(dataDir, pin, serving(tarball));
    chmodSync(pinnedDir(dataDir, pin), 0o575);
    const failure = await verifyPinned(dataDir, pin).catch((e: unknown) => e);
    expect((failure as PinnedToolError).message).toContain('is writable by a group or others');
  });

  it('is refused when its folder has no record of what it is', async () => {
    const tarball = buildTarball('bare', '1.2.3');
    const pin = await pinFor(tarball);
    const target = pinnedDir(dataDir, pin);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'claude'), '#!/bin/sh\necho evil\n');
    const failure = await ensurePinned(dataDir, pin, serving(tarball)).catch((e: unknown) => e);
    expect((failure as PinnedToolError).message).toContain('has no readable record');
  });
});
