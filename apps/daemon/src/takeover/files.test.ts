import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mintId, TerminalApp } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  createTakeoverFolder,
  readTakeoverRecord,
  removeTakeoverFolder,
  takeoverFolderOf,
  TakeoverFilesError,
  writeTakeoverFile,
  writeTakeoverRecord,
} from './files';

// Sessions spec §7.5, security row 5: the takeover folder is 10db's, so a link planted where a write or a
// recursive remove would go is refused and its target left alone.

const dirs: { cleanup(): void }[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});
function world() {
  const data = tempDir('takeover-files');
  const outside = tempDir('takeover-outside');
  dirs.push(data, outside);
  const id = mintId('Conversation');
  const target = join(outside.path, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'precious');
  return { data: data.path, id, outside: outside.path, target };
}
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('the takeover folder', () => {
  it('is made private, and its files are written with the mode they need', () => {
    const w = world();
    const folder = createTakeoverFolder(w.data, w.id);
    expect(folder).toBe(takeoverFolderOf(w.data, w.id));
    expect(mode(folder)).toBe(0o700);
    const script = writeTakeoverFile(folder, 'run.command', '#!/bin/sh\n', 0o700);
    const config = writeTakeoverFile(folder, 'mcp.json', '{}', 0o600);
    expect(mode(script)).toBe(0o700);
    expect(mode(config)).toBe(0o600);
    expect(readFileSync(config, 'utf8')).toBe('{}');
  });

  it('replaces a file the agent made a link, writing nothing through it', () => {
    const w = world();
    const folder = createTakeoverFolder(w.data, w.id);
    symlinkSync(join(w.target, 'keep'), join(folder, 'mcp.json'));
    writeTakeoverFile(folder, 'mcp.json', 'new', 0o600);
    expect(lstatSync(join(folder, 'mcp.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(w.target, 'keep'), 'utf8')).toBe('precious');
  });

  it('refuses a name that leaves the folder', () => {
    const w = world();
    const folder = createTakeoverFolder(w.data, w.id);
    for (const name of ['../x', 'a/b', '', '..'])
      expect(() => writeTakeoverFile(folder, name, 'x', 0o600)).toThrow(TakeoverFilesError);
  });

  it.each([
    {
      name: 'the conversation folder',
      plant: (w: ReturnType<typeof world>) => {
        mkdirSync(join(w.data, 'conversations'));
        symlinkSync(w.target, join(w.data, 'conversations', w.id));
      },
    },
    {
      name: 'the takeover folder',
      plant: (w: ReturnType<typeof world>) => {
        mkdirSync(join(w.data, 'conversations', w.id), { recursive: true });
        symlinkSync(w.target, join(w.data, 'conversations', w.id, 'takeover'));
      },
    },
    {
      name: 'the conversations folder',
      plant: (w: ReturnType<typeof world>) => {
        symlinkSync(w.outside, join(w.data, 'conversations'));
      },
    },
  ])('refuses a link at $name, and a remove leaves its target', ({ plant }) => {
    const w = world();
    plant(w);
    expect(() => createTakeoverFolder(w.data, w.id)).toThrow(TakeoverFilesError);
    removeTakeoverFolder(w.data, w.id);
    expect(readFileSync(join(w.target, 'keep'), 'utf8')).toBe('precious');
    expect(existsSync(join(w.outside, 'target'))).toBe(true);
  });

  it('removes the folder and everything in it, and is idempotent', () => {
    const w = world();
    const folder = createTakeoverFolder(w.data, w.id);
    writeTakeoverFile(folder, 'mcp.json', '{}', 0o600);
    removeTakeoverFolder(w.data, w.id);
    expect(existsSync(folder)).toBe(false);
    removeTakeoverFolder(w.data, w.id);
  });
});

describe('takeover.json', () => {
  it('is read through its schema, and anything else reads as none', () => {
    const w = world();
    const folder = createTakeoverFolder(w.data, w.id);
    expect(readTakeoverRecord(folder)).toBeNull();
    const record = {
      since: '2026-11-16T10:00:00.000Z',
      app: TerminalApp.Copy,
      tempDirs: ['/tmp/10db/a'],
    };
    writeTakeoverRecord(folder, record);
    expect(readTakeoverRecord(folder)).toEqual(record);
    writeFileSync(join(folder, 'takeover.json'), '{"since":3}');
    expect(readTakeoverRecord(folder)).toBeNull();
    writeFileSync(join(folder, 'takeover.json'), 'not json');
    expect(readTakeoverRecord(folder)).toBeNull();
  });
});
