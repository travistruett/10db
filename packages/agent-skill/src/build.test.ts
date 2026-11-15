import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentSkill, skillDigest } from './index';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('skillDigest', () => {
  const files = [
    { path: 'b', bytes: bytes('two') },
    { path: 'a', bytes: bytes('one') },
  ];

  it('is twelve hex digits and ignores the order of the files', () => {
    const digest = skillDigest(files);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(skillDigest([...files].reverse())).toBe(digest);
  });

  it('changes when one byte changes, or when a byte moves between files', () => {
    const digest = skillDigest(files);
    expect(
      skillDigest([
        { path: 'b', bytes: bytes('two') },
        { path: 'a', bytes: bytes('onf') },
      ]),
    ).not.toBe(digest);
    expect(
      skillDigest([
        { path: 'b', bytes: bytes('wo') },
        { path: 'a', bytes: bytes('tone') },
      ]),
    ).not.toBe(digest);
  });
});

describe('buildAgentSkill', () => {
  const made: string[] = [];
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-skill-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the four files, with a VERSION that is the digest of the other three', async () => {
    const out = join(temp(), 'skill');
    const { version } = await buildAgentSkill(out);
    expect(readdirSync(out).sort()).toEqual(['README.md', 'SKILL.md', 'VERSION', 'tendb.mjs']);
    const parts = ['SKILL.md', 'README.md', 'tendb.mjs'].map((path) => ({
      path,
      bytes: readFileSync(join(out, path)),
    }));
    expect(readFileSync(join(out, 'VERSION'), 'utf8')).toBe(`${skillDigest(parts)}\n`);
    expect(version).toBe(skillDigest(parts));
  });

  it('removes and rewrites only its own four names', async () => {
    const out = temp();
    writeFileSync(join(out, 'keep.txt'), 'mine');
    mkdirSync(join(out, 'other'));
    writeFileSync(join(out, 'SKILL.md'), 'stale');
    await buildAgentSkill(out);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(join(out, 'other'))).toEqual([]);
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).not.toBe('stale');
  });

  it('builds a bundle that runs under plain node, with no node_modules, and refuses an unknown command', async () => {
    const out = join(temp(), 'skill');
    await buildAgentSkill(out);
    const fresh = join(temp(), 'copy');
    cpSync(out, fresh, { recursive: true });
    const run = spawnSync(process.execPath, [join(fresh, 'tendb.mjs'), 'nope'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage:');
  });
});
