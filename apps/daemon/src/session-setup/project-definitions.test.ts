import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, tempDir, type TempDir } from '../../test/fixtures';
import {
  PROJECT_DEFINITIONS_MAX_BYTES,
  PROJECT_FILE_MAX_BYTES,
  readProjectDefinitions,
  type DefinitionFile,
} from './project-definitions';

let repo: TempDir;
let outside: TempDir;
let checkout: string;

beforeEach(() => {
  repo = createTempRepo();
  outside = tempDir('definitions-outside');
  checkout = realpathSync(repo.path);
});

afterEach(() => {
  repo.cleanup();
  outside.cleanup();
});

function write(relative: string, content: string | Buffer, mode = 0o644): string {
  const path = join(checkout, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function byPath(files: readonly DefinitionFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.relative, f.content.toString('utf8')]));
}

const SKILL = '---\nname: s\ndescription: does s\n---\nUse it.\n';

describe('readProjectDefinitions', () => {
  it('copies a skill folder with its script and a PNG, bytes and mode kept', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    write('.claude/skills/s/SKILL.md', SKILL);
    write('.claude/skills/s/scripts/run.sh', '#!/bin/sh\necho hi\n', 0o755);
    write('.claude/skills/s/logo.png', png);
    write('.claude/commands/c.md', '---\ndescription: c\n---\nDo c.\n');
    write('.claude/agents/a.md', '---\nname: a\ntools: Read\n---\nYou are a.\n');
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(leftOut).toEqual([]);
    expect(files.map((f) => f.relative).sort()).toEqual([
      'agents/a.md',
      'commands/c.md',
      'skills/s/SKILL.md',
      'skills/s/logo.png',
      'skills/s/scripts/run.sh',
    ]);
    const find = (relative: string) => files.find((f) => f.relative === relative);
    expect(find('skills/s/logo.png')?.content.equals(png)).toBe(true);
    expect(find('skills/s/scripts/run.sh')?.mode).toBe(0o700);
    expect(find('skills/s/logo.png')?.mode).toBe(0o600);
    expect(find('skills/s/SKILL.md')?.content.toString('utf8')).toBe(SKILL);
  });

  it('removes lane-written power from a definition it keeps, and lists what it removed', () => {
    write(
      '.claude/commands/c.md',
      '---\ndescription: c\nmodel: opus\nhooks: {}\n---\n!`id`\n!`ls`\nok\n',
    );
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(byPath(files)).toEqual({ 'commands/c.md': '---\ndescription: c\n---\nok\n' });
    expect(leftOut).toEqual([
      {
        what: '.claude/commands/c.md',
        why: 'model, hooks, 2 shell lines removed: a lane can write this file',
      },
    ]);
  });

  it('leaves out a skill whose .claude/skills is a link', () => {
    mkdirSync(join(outside.path, 's'));
    writeFileSync(join(outside.path, 's/SKILL.md'), SKILL);
    mkdirSync(join(checkout, '.claude'));
    symlinkSync(outside.path, join(checkout, '.claude/skills'));
    expect(readProjectDefinitions(checkout)).toEqual({
      files: [],
      leftOut: [{ what: '.claude/skills', why: 'it is a link' }],
    });
  });

  it('leaves out a command that is a link', () => {
    writeFileSync(join(outside.path, 'c.md'), 'outside');
    mkdirSync(join(checkout, '.claude/commands'), { recursive: true });
    symlinkSync(join(outside.path, 'c.md'), join(checkout, '.claude/commands/c.md'));
    expect(readProjectDefinitions(checkout)).toEqual({
      files: [],
      leftOut: [{ what: '.claude/commands/c.md', why: 'it must be a regular file, not a link' }],
    });
  });

  it('leaves out a whole skill holding a link', () => {
    write('.claude/skills/s/SKILL.md', SKILL);
    writeFileSync(join(outside.path, 'secret'), 'outside');
    symlinkSync(join(outside.path, 'secret'), join(checkout, '.claude/skills/s/data'));
    expect(readProjectDefinitions(checkout)).toEqual({
      files: [],
      leftOut: [{ what: '.claude/skills/s', why: 'data: it must be a regular file, not a link' }],
    });
  });

  it('leaves out a whole skill when one of its files is over the file cap', () => {
    write('.claude/skills/s/SKILL.md', SKILL);
    write('.claude/skills/s/big.bin', Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1));
    write('.claude/skills/t/SKILL.md', SKILL);
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(files.map((f) => f.relative)).toEqual(['skills/t/SKILL.md']);
    expect(leftOut).toEqual([
      { what: '.claude/skills/s', why: 'big.bin: it is larger than 256 KiB' },
    ]);
  });

  it('does not copy a .env file or folder inside a skill folder, in any case, and lists it', () => {
    write('.claude/skills/s/SKILL.md', SKILL);
    write('.claude/skills/s/.env.local', 'TOKEN=x');
    write('.claude/skills/s/conf/.Env.prod', 'TOKEN=y');
    write('.claude/skills/s/.ENV.d/prod', 'TOKEN=z');
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(files.map((f) => f.relative)).toEqual(['skills/s/SKILL.md']);
    expect(files[0]?.source).toBe('.claude/skills/s/SKILL.md');
    expect(leftOut).toEqual([
      { what: '.claude/skills/s/.ENV.d', why: 'a secrets file is never copied' },
      { what: '.claude/skills/s/.env.local', why: 'a secrets file is never copied' },
      { what: '.claude/skills/s/conf/.Env.prod', why: 'a secrets file is never copied' },
    ]);
  });

  it('does not copy a skill’s agents/openai.yaml, which Codex reads to install and run servers', () => {
    write('.claude/skills/s/SKILL.md', SKILL);
    write('.claude/skills/s/agents/openai.yaml', 'dependencies:\n  tools: []\n');
    write('.claude/skills/s/agents/notes.md', 'notes');
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(files.map((f) => f.relative).sort()).toEqual([
      'skills/s/SKILL.md',
      'skills/s/agents/notes.md',
    ]);
    expect(leftOut).toEqual([
      {
        what: '.claude/skills/s/agents/openai.yaml',
        why: 'Codex reads it to install and run what it names',
      },
    ]);
  });

  it('drops an agents/openai.yaml at any depth, in any case, and cleans a nested SKILL.md', () => {
    write('.claude/skills/s/SKILL.md', SKILL);
    write('.claude/skills/s/sub/SKILL.md', '---\nname: sub\nhooks: {}\n---\nRun !`id`\n');
    write('.claude/skills/s/sub/Agents/OpenAI.yaml', 'dependencies:\n  tools: []\n');
    const { files, leftOut } = readProjectDefinitions(checkout);
    expect(byPath(files)).toEqual({
      'skills/s/SKILL.md': SKILL,
      'skills/s/sub/SKILL.md': '---\nname: sub\n---\n',
    });
    expect(leftOut).toEqual([
      {
        what: '.claude/skills/s/sub/Agents/OpenAI.yaml',
        why: 'Codex reads it to install and run what it names',
      },
      {
        what: '.claude/skills/s/sub/SKILL.md',
        why: 'hooks, 1 shell line removed: a lane can write this file',
      },
    ]);
  });

  it('leaves out a definition whose frontmatter is refused', () => {
    write('.claude/agents/a.md', '---\nname: &n a\ndescription: *n\n---\nYou\n');
    write('.claude/skills/s/SKILL.md', '---\nname: s\n...\nhooks: x\n---\nBody\n');
    expect(readProjectDefinitions(checkout)).toEqual({
      files: [],
      leftOut: [
        { what: '.claude/skills/s', why: 'its frontmatter holds more than one document' },
        { what: '.claude/agents/a.md', why: 'its frontmatter uses an alias' },
      ],
    });
  });

  it('leaves out a skill with no SKILL.md', () => {
    write('.claude/skills/s/notes.md', 'x');
    expect(readProjectDefinitions(checkout)).toEqual({
      files: [],
      leftOut: [{ what: '.claude/skills/s', why: 'no SKILL.md' }],
    });
  });

  it('leaves out whole definitions past the byte cap', () => {
    const chunk = Buffer.alloc(PROJECT_FILE_MAX_BYTES - 1024);
    const per = 2 * chunk.length;
    const fit = Math.floor(PROJECT_DEFINITIONS_MAX_BYTES / per);
    const names = Array.from({ length: fit + 2 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    for (const name of names) {
      write(`.claude/skills/${name}/SKILL.md`, SKILL);
      write(`.claude/skills/${name}/a.bin`, chunk);
      write(`.claude/skills/${name}/b.bin`, chunk);
    }
    write('.claude/commands/c.md', 'c');
    const { files, leftOut } = readProjectDefinitions(checkout);
    const total = files.reduce((sum, f) => sum + f.content.length, 0);
    expect(total).toBeLessThanOrEqual(PROJECT_DEFINITIONS_MAX_BYTES);
    expect(new Set(files.map((f) => f.relative.split('/')[1]))).toEqual(
      new Set(names.slice(0, fit)),
    );
    expect(leftOut).toEqual([
      ...names.slice(fit).map((name) => ({
        what: `.claude/skills/${name}`,
        why: 'past the 4 MiB or 500 files 10db copies',
      })),
      { what: '.claude/commands/c.md', why: 'past the 4 MiB or 500 files 10db copies' },
    ]);
  });

  it('no .claude dir is empty', () => {
    expect(readProjectDefinitions(checkout)).toEqual({ files: [], leftOut: [] });
  });
});
