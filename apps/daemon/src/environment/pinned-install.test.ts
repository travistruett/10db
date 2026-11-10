import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeTarball, pinForTarball, servingTarball } from '../../test/pinned-tarball';
import { tempDir } from '../../test/fixtures';
import type { AgentPin, PinnedRelease } from './agent-pins';
import {
  downloadFile,
  ensurePinned,
  extractZipWithTar,
  installPinned,
  pinnedDir,
  pinnedExecutable,
  pinnedToolsRoot,
  PinnedToolError,
  prunePinned,
  removePinned,
  tarballIntegrity,
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
  it('is installed from a download that matches its recorded checksum, and runs', async () => {
    const tarball = buildTarball('good', '1.2.3 (Claude Code)');
    const pin = await pinFor(tarball);
    const net = serving(tarball);
    const exe = await ensurePinned(dataDir, pin, net);
    expect(exe).toBe(pinnedExecutable(dataDir, pin));
    expect(execFileSync(exe, ['--version'], { encoding: 'utf8' })).toBe('1.2.3 (Claude Code)\n');
    // Only the part 10db runs is kept, and the staging area is gone.
    expect(readdirSync(pinnedDir(dataDir, pin)).sort()).toEqual(['.pin.json', 'claude']);
    expect(readdirSync(pinnedToolsRoot(dataDir))).toEqual([`claude-1.2.3-darwin-arm64`]);
  });

  it('is fetched once: a second start verifies what is there', async () => {
    const tarball = buildTarball('once', '1.2.3');
    const pin = await pinFor(tarball);
    const net = serving(tarball);
    await ensurePinned(dataDir, pin, net);
    await ensurePinned(dataDir, pin, net);
    expect(net.calls()).toBe(1);
  });

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

  it('says so when the download itself fails', async () => {
    const tarball = buildTarball('offline', '1.2.3');
    const pin = await pinFor(tarball);
    const failure = await ensurePinned(dataDir, pin, {
      download: () => Promise.reject(new Error('getaddrinfo ENOTFOUND registry.example.test')),
      extract: serving(tarball).extract,
    }).catch((e: unknown) => e);
    expect((failure as PinnedToolError).message).toMatch(
      /Claude Code 1\.2\.3 was refused: the download from .* failed: getaddrinfo ENOTFOUND/,
    );
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

  it('leaves another release of the same tool in place: a live test must not take the running app’s copy', async () => {
    const oldTarball = buildTarball('old', '1.2.2');
    const oldPin = await pinFor(oldTarball, '1.2.2');
    await ensurePinned(dataDir, oldPin, serving(oldTarball));
    const tarball = buildTarball('new', '1.2.3');
    const pin = await pinFor(tarball);
    await ensurePinned(dataDir, pin, serving(tarball));
    expect(readdirSync(pinnedToolsRoot(dataDir)).sort()).toEqual([
      'claude-1.2.2-darwin-arm64',
      'claude-1.2.3-darwin-arm64',
    ]);
    await prunePinned(dataDir, pin);
    expect(readdirSync(pinnedToolsRoot(dataDir))).toEqual(['claude-1.2.3-darwin-arm64']);
  });

  it('is installed once when two installs race: the second finds the first one’s copy', async () => {
    const tarball = buildTarball('race', '1.2.3');
    const pin = await pinFor(tarball);
    const [a, b] = await Promise.all([
      ensurePinned(dataDir, pin, serving(tarball)),
      ensurePinned(dataDir, pin, serving(tarball)),
    ]);
    expect(a).toBe(pinnedExecutable(dataDir, pin));
    expect(b).toBe(a);
    expect(readdirSync(pinnedToolsRoot(dataDir))).toEqual(['claude-1.2.3-darwin-arm64']);
  });

  it('is fetched again in place of a refused copy when asked to replace it', async () => {
    const tarball = buildTarball('replaced', '1.2.3 (Claude Code)');
    const pin = await pinFor(tarball);
    const net = serving(tarball);
    const exe = await ensurePinned(dataDir, pin, net);
    chmodSync(pinnedDir(dataDir, pin), 0o755);
    chmodSync(exe, 0o755);
    writeFileSync(exe, '#!/bin/sh\necho owned\n');
    // Without the ask, the copy stays refused and nothing is fetched.
    await expect(ensurePinned(dataDir, pin, net)).rejects.toThrow(/no longer match/);
    expect(net.calls()).toBe(1);
    await ensurePinned(dataDir, pin, net, { replaceRefused: true });
    expect(net.calls()).toBe(2);
    expect(execFileSync(exe, ['--version'], { encoding: 'utf8' })).toBe('1.2.3 (Claude Code)\n');
  });

  it('installs a pin whose kept part is a folder, as Codex ships', async () => {
    const src = join(dir.path, 'codex-src', 'package', 'vendor', 'aarch64-apple-darwin');
    mkdirSync(join(src, 'bin'), { recursive: true });
    mkdirSync(join(src, 'codex-path'), { recursive: true });
    writeFileSync(join(src, 'bin', 'codex'), '#!/bin/sh\necho codex-cli 0.9.9\n', { mode: 0o755 });
    writeFileSync(join(src, 'codex-path', 'rg'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dir.path, 'codex-src', 'package', 'package.json'), '{}');
    const tarball = join(dir.path, 'codex.tgz');
    execFileSync('/usr/bin/tar', ['-czf', tarball, '-C', join(dir.path, 'codex-src'), 'package']);
    const pin: AgentPin = {
      ...(await pinFor(tarball, '0.9.9')),
      tool: 'codex',
      label: 'Codex',
      member: 'package/vendor/aarch64-apple-darwin',
      strip: 3,
      executable: 'bin/codex',
    };
    await installPinned(dataDir, pin, serving(tarball));
    const exe = await verifyPinned(dataDir, pin);
    expect(execFileSync(exe, [], { encoding: 'utf8' })).toBe('codex-cli 0.9.9\n');
    expect(readFileSync(join(pinnedDir(dataDir, pin), 'codex-path', 'rg'), 'utf8')).toBe(
      '#!/bin/sh\n',
    );
  });

  it('installs a pin shipped as a zip, as Chrome for Testing ships, from its top folder', async () => {
    const src = join(dir.path, 'zip-src', 'shell-mac-arm64');
    mkdirSync(join(src, 'resources'), { recursive: true });
    writeFileSync(join(src, 'shell'), '#!/bin/sh\necho shell 9.9\n', { mode: 0o755 });
    writeFileSync(join(src, 'resources', 'a.pak'), 'pak');
    const zip = join(dir.path, 'shell.zip');
    execFileSync('/usr/bin/tar', [
      '--format',
      'zip',
      '-cf',
      zip,
      '-C',
      join(dir.path, 'zip-src'),
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
    const exe = await ensurePinned(dataDir, pin, {
      download: (_url, to) => {
        copyFileSync(zip, to);
        return Promise.resolve();
      },
      extract: extractZipWithTar,
    });
    expect(exe).toBe(pinnedExecutable(dataDir, pin));
    expect(execFileSync(exe, [], { encoding: 'utf8' })).toBe('shell 9.9\n');
    expect(readFileSync(join(pinnedDir(dataDir, pin), 'resources', 'a.pak'), 'utf8')).toBe('pak');
  });
});

describe('downloadFile', () => {
  it('refuses an answer that is not a success', async () => {
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((_req, res) => {
        res.statusCode = 404;
        res.end('no');
      });
      s.listen(0, '127.0.0.1', () => {
        resolve(s);
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      await expect(
        downloadFile(`http://127.0.0.1:${String(address.port)}/x.tgz`, join(dir.path, 'x.tgz')),
      ).rejects.toThrow(/answered 404/);
    } finally {
      server.close();
    }
  });
});
