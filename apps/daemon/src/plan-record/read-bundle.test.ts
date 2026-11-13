import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, PlanBundle } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { BUNDLE_MAX_BYTES, bodyFilesToRead, inlineBundle, readBundleFile } from './read-bundle';

// Every row runs on the real file system: what a bundle may read is a security rule.

const AT = '2026-11-12T08:00:00.000Z';
const projectId = mintId('Project');

let root: TempDir;
let dataDir: string;
let folder: string;
beforeEach(() => {
  root = tempDir('bundle');
  dataDir = join(root.path, 'data');
  folder = join(root.path, 'effort');
  mkdirSync(dataDir);
  mkdirSync(folder);
});
afterEach(() => {
  root.cleanup();
});

const bundleOf = (revisions: unknown[]) => ({
  id: 'remote-host',
  projectId,
  title: 'Remote host',
  origin: { kind: 'claude_code', at: AT },
  documents: [{ key: 'p1', kind: 'plan', title: 'P1', revisions }],
});

/** Writes the bundle file into `dir` and answers its path. */
function writeBundle(revisions: unknown[], dir = folder): string {
  const path = join(dir, 'bundle.json');
  writeFileSync(path, JSON.stringify(bundleOf(revisions)));
  return path;
}

const read = (path: string) => readBundleFile(path, { dataDir });

async function refused(path: string): Promise<string> {
  const result = await read(path);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
}

describe('readBundleFile', () => {
  it('reads a bundle with inline and bodyPath revisions', async () => {
    writeFileSync(join(folder, 'p1-r2.md'), '# P1 r2\n');
    const result = await read(
      writeBundle([
        { number: 1, body: '# P1\n', at: AT },
        { number: 2, bodyPath: 'p1-r2.md', at: AT },
      ]),
    );
    expect(result.ok && [...result.bodies]).toEqual([
      ['p1#1', '# P1\n'],
      ['p1#2', '# P1 r2\n'],
    ]);
  });

  it('a relative bundlePath is refused', async () => {
    expect(await refused('effort/bundle.json')).toMatch(/absolute/);
  });

  it('a bundlePath that is a folder is refused', async () => {
    expect(await refused(folder)).toMatch(/regular file/);
  });

  it('a missing bundlePath is refused', async () => {
    expect(await refused(join(folder, 'none.json'))).toMatch(/regular file|not found|no file/i);
  });

  it('a link to a bundle elsewhere reads by its real path', async () => {
    writeFileSync(join(folder, 'p1.md'), '# P1 beside the real bundle\n');
    const real = writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]);
    const link = join(root.path, 'link.json');
    symlinkSync(real, link);
    const result = await read(link);
    expect(result.ok && result.bodies.get('p1#1')).toBe('# P1 beside the real bundle\n');
  });

  it('a bundle under the data dir is refused', async () => {
    expect(await refused(writeBundle([{ number: 1, body: 'x', at: AT }], dataDir))).toMatch(
      /data dir/,
    );
  });

  it('a bundle linked from outside into the data dir is refused', async () => {
    const inside = writeBundle([{ number: 1, body: 'x', at: AT }], dataDir);
    const link = join(folder, 'outside.json');
    symlinkSync(inside, link);
    expect(await refused(link)).toMatch(/data dir/);
  });

  it('a bodyPath with .. out of the folder is refused', async () => {
    writeFileSync(join(root.path, 'secret.md'), 'secret');
    expect(await refused(writeBundle([{ number: 1, bodyPath: '../secret.md', at: AT }]))).toMatch(
      /bundle's folder/,
    );
  });

  it('an absolute bodyPath is refused', async () => {
    const abs = join(folder, 'p1.md');
    writeFileSync(abs, '# P1');
    expect(await refused(writeBundle([{ number: 1, bodyPath: abs, at: AT }]))).toMatch(/relative/);
  });

  it('a bodyPath link pointing out of the folder is refused', async () => {
    writeFileSync(join(root.path, 'secret.md'), 'secret');
    symlinkSync(join(root.path, 'secret.md'), join(folder, 'p1.md'));
    expect(await refused(writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]))).toMatch(
      /bundle's folder/,
    );
  });

  it('a bodyPath to a FIFO is refused without blocking', async () => {
    execFileSync('mkfifo', [join(folder, 'p1.md')]);
    expect(await refused(writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]))).toMatch(
      /regular file/,
    );
  });

  it('a bodyPath to a folder is refused', async () => {
    mkdirSync(join(folder, 'p1.md'));
    expect(await refused(writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]))).toMatch(
      /regular file/,
    );
  });

  it('16 MiB in all reads, one byte more is refused', async () => {
    const path = writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]);
    const bundleBytes = Buffer.byteLength(
      JSON.stringify(bundleOf([{ number: 1, bodyPath: 'p1.md', at: AT }])),
    );
    writeFileSync(join(folder, 'p1.md'), 'x'.repeat(BUNDLE_MAX_BYTES - bundleBytes));
    const fits = await read(path);
    expect(fits.ok && fits.bodies.get('p1#1')?.length).toBe(BUNDLE_MAX_BYTES - bundleBytes);
    writeFileSync(join(folder, 'p1.md'), 'x'.repeat(BUNDLE_MAX_BYTES - bundleBytes + 1));
    expect(await refused(path)).toMatch(/16 MiB/);
  });

  it('invalid UTF-8 is refused', async () => {
    writeFileSync(join(folder, 'p1.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    expect(await refused(writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]))).toMatch(/UTF-8/);
  });

  it('a BOM, CRLF and NUL-free text come back byte for byte', async () => {
    const bytes = Buffer.from('﻿# Settings › Sharing\r\n\r\ntrailing  \r\n', 'utf8');
    writeFileSync(join(folder, 'p1.md'), bytes);
    const result = await read(writeBundle([{ number: 1, bodyPath: 'p1.md', at: AT }]));
    const body = result.ok ? (result.bodies.get('p1#1') ?? '') : '';
    expect(Buffer.from(body, 'utf8').equals(bytes)).toBe(true);
  });

  it("JSON that doesn't parse names the file, not its contents", async () => {
    const path = join(folder, 'bundle.json');
    writeFileSync(path, '{"id": "secret-token-123", ');
    const message = await refused(path);
    expect(message).toMatch(/not JSON/);
    expect(message).toContain('bundle.json');
    expect(message).not.toContain('secret-token-123');
  });
});

describe('inlineBundle', () => {
  it('an inline bundle with a bodyPath is refused', () => {
    const result = inlineBundle(
      PlanBundle.parse(bundleOf([{ number: 1, bodyPath: 'p1.md', at: AT }])),
    );
    expect(result.ok ? [] : result.errors.map((e) => e.message)).toEqual([
      'bodyPath needs bundlePath',
    ]);
  });
});

describe('bodyFilesToRead', () => {
  const bundle = (paths: string[]) =>
    PlanBundle.parse(bundleOf(paths.map((bodyPath, i) => ({ number: i + 1, bodyPath, at: AT }))));

  it('two revisions naming one file give one file with two refs', () => {
    expect(bodyFilesToRead(bundle(['p1.md', 'p1.md']), (p) => `/real/${p}`)).toEqual([
      { realPath: '/real/p1.md', refs: ['p1#1', 'p1#2'] },
    ]);
  });

  it('a link and its target give one file', () => {
    const real = (p: string) => (p === 'link.md' ? '/real/p1.md' : `/real/${p}`);
    expect(bodyFilesToRead(bundle(['p1.md', 'link.md']), real)).toEqual([
      { realPath: '/real/p1.md', refs: ['p1#1', 'p1#2'] },
    ]);
  });

  it('two files give two', () => {
    expect(bodyFilesToRead(bundle(['p1.md', 'p2.md']), (p) => `/real/${p}`)).toEqual([
      { realPath: '/real/p1.md', refs: ['p1#1'] },
      { realPath: '/real/p2.md', refs: ['p1#2'] },
    ]);
  });
});
