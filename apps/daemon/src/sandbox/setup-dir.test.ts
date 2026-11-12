import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { homeProtectedReads } from './protected-reads';
import { createSetupDir, keepSetup } from './setup-dir';
import type { SetupInput } from './setup-input';
import { setupReadRefusal, type SetupReadContext } from './setup-reads';

let root: TempDir;
let home: string;
let outside: string;
let checkout: string;
let filesRoot: string;
let ctx: SetupReadContext;

const refuse = (real: string): string | null => setupReadRefusal(real, ctx);

beforeEach(() => {
  root = tempDir('setup-dir');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  outside = join(base, 'outside');
  checkout = join(base, 'checkout');
  filesRoot = join(base, 'files');
  for (const dir of [home, outside, checkout, filesRoot]) mkdirSync(dir);
  ctx = {
    home,
    protectedReads: homeProtectedReads(home),
    secretFiles: [],
    sandboxRoots: [filesRoot],
    laneWritable: [checkout],
  };
});

/** Folders a row made unlistable, given back so the temp dir can go. */
const unlistable: string[] = [];

afterEach(() => {
  for (const locked of unlistable.splice(0)) chmodSync(locked, 0o700);
  root.cleanup();
});

function skillAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
  return dir;
}

function builderSkill(name: string, dir = skillAt(join(home, '.claude/skills', name))) {
  return { name, path: join(home, '.claude/skills', name), skillFile: join(dir, 'SKILL.md') };
}

function linkedSkill(name: string, target: string) {
  skillAt(target);
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  symlinkSync(target, join(home, '.claude/skills', name));
  return { name, path: join(home, '.claude/skills', name), skillFile: join(target, 'SKILL.md') };
}

/** A folder outside the home, named as the setup names it. */
const shownOutside = (name: string): string => join(outside, name);

function input(overrides: Partial<SetupInput> = {}): SetupInput {
  return { skills: [], plugins: [], projectFiles: [], ...overrides };
}

describe('keepSetup and createSetupDir', () => {
  it('links each kept skill under yours/skills and writes the manifest', () => {
    const s = builderSkill('s');
    const made = createSetupDir(filesRoot, input({ skills: [s] }), refuse, home);
    const yours = made.setup.pluginDirs[0] ?? '';
    expect(yours).toMatch(/\/10db-setup-[0-9a-f]{12}\/yours$/);
    expect(readlinkSync(join(yours, 'skills/s'))).toBe(join(home, '.claude/skills/s'));
    expect(JSON.parse(readFileSync(join(yours, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'yours',
    });
    expect(made.setup.skillRoots).toEqual([join(yours, 'skills')]);
    expect(made.setup.loaded).toEqual({ skills: ['s'], plugins: [] });
    expect(made.setup.leftOut).toEqual([]);
    expect(statSync(join(yours, '..')).mode & 0o777).toBe(0o700);
    made.remove();
  });

  it('leaves out a skill whose folder the refusal names, with its sentence', () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh/SKILL.md'), 'x');
    const ssh = linkedSkill('ssh', join(home, '.ssh'));
    const kept = keepSetup(input({ skills: [ssh] }), refuse, home);
    expect(kept.keptSkills).toEqual([]);
    expect(kept.leftOut).toEqual([
      {
        what: '~/.claude/skills/ssh',
        why: 'it lies under ~/Library or a hidden folder of your home',
      },
    ]);
    expect(kept.reads).toEqual([]);
  });

  it('no skills kept opens no root', () => {
    builderSkill('s');
    skillAt(join(home, '.agents/skills/t'));
    expect(keepSetup(input(), refuse, home).reads).toEqual([]);
    const s = builderSkill('s');
    expect(keepSetup(input({ skills: [s] }), refuse, home).reads).toEqual([
      join(home, '.claude/skills'),
    ]);
  });

  it('leaves out a skill whose SKILL.md leads into a checkout', () => {
    writeFileSync(join(checkout, 'SKILL.md'), 'lane written');
    const dir = join(home, '.claude/skills/s');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(checkout, 'SKILL.md'), join(dir, 'SKILL.md'));
    const s = { name: 's', path: dir, skillFile: join(checkout, 'SKILL.md') };
    const kept = keepSetup(input({ skills: [s] }), refuse, home);
    expect(kept.keptSkills).toEqual([]);
    expect(kept.leftOut).toEqual([
      { what: '~/.claude/skills/s', why: 'it lies in, or holds, a folder a lane can write' },
    ]);
    expect(kept.reads.some((read) => read.startsWith(checkout))).toBe(false);
  });

  it('keeps a skill whose SKILL.md leads into another skill folder, and reads that folder', () => {
    const a = join(outside, 'a');
    mkdirSync(a);
    skillAt(join(outside, 'b'));
    symlinkSync(join(outside, 'b/SKILL.md'), join(a, 'SKILL.md'));
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(a, join(home, '.claude/skills/a'));
    const s = {
      name: 'a',
      path: join(home, '.claude/skills/a'),
      skillFile: join(outside, 'b/SKILL.md'),
    };
    const kept = keepSetup(input({ skills: [s] }), refuse, home);
    expect(kept.keptSkills).toEqual([s]);
    // ~/.claude/skills holds only the link, so it stays closed: the kernel judges the real path.
    expect(kept.reads).toEqual([a, join(outside, 'b')]);
  });

  it('leaves out a plugin whose folder is gone', () => {
    const kept = keepSetup(
      input({ plugins: [{ id: 'p@m', path: join(home, '.claude/plugins/cache/m/p/1') }] }),
      refuse,
      home,
    );
    expect(kept.keptPlugins).toEqual([]);
    expect(kept.leftOut).toEqual([
      { what: 'p@m', why: 'its folder is gone; Claude Code may have updated it' },
    ]);
  });

  it('opens ~/.claude/skills whole when every child passes', () => {
    const s = builderSkill('s');
    const t = builderSkill('t');
    const plugin = join(home, '.claude/plugins/cache/m/p/1');
    mkdirSync(plugin, { recursive: true });
    const kept = keepSetup(
      input({ skills: [s, t], plugins: [{ id: 'p@m', path: plugin }] }),
      refuse,
      home,
    );
    expect(kept.reads).toEqual([plugin, join(home, '.claude/skills')]);
  });

  it('200 skills and one refused link still open the root whole', () => {
    const skills = Array.from({ length: 200 }, (_, i) => builderSkill(`s${String(i)}`));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh/SKILL.md'), 'x');
    const ssh = linkedSkill('ssh', join(home, '.ssh'));
    const kept = keepSetup(input({ skills: [...skills, ssh] }), refuse, home);
    expect(kept.keptSkills).toHaveLength(200);
    expect(kept.reads).toEqual([join(home, '.claude/skills')]);
  });

  it('opens the passing folders one by one when a real directory in the root is refused', () => {
    const s = builderSkill('s');
    const bad = builderSkill('bad');
    ctx = { ...ctx, laneWritable: [...ctx.laneWritable, join(home, '.claude/skills/bad')] };
    const kept = keepSetup(input({ skills: [s, bad] }), refuse, home);
    expect(kept.keptSkills).toEqual([s]);
    expect(kept.reads).toEqual([join(home, '.claude/skills/s')]);
  });

  it('leaves out a skill holding a folder that can’t be listed, and does not throw', () => {
    const s = builderSkill('s');
    const t = builderSkill('t');
    const locked = join(home, '.claude/skills/t/locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    unlistable.push(locked);
    const kept = keepSetup(input({ skills: [s, t] }), refuse, home);
    expect(kept.keptSkills).toEqual([s]);
    expect(kept.leftOut).toEqual([
      { what: '~/.claude/skills/t', why: "a folder in it can't be listed: locked" },
    ]);
    expect(kept.reads).toEqual([join(home, '.claude/skills/s')]);
  });

  it('collapses link targets outside the roots', () => {
    const x = linkedSkill('x', join(outside, 'x'));
    skillAt(join(outside, 'x/inner'));
    const dir = join(home, '.claude/skills/y');
    mkdirSync(dir);
    symlinkSync(join(outside, 'x/inner/SKILL.md'), join(dir, 'SKILL.md'));
    const y = { name: 'y', path: dir, skillFile: join(outside, 'x/inner/SKILL.md') };
    const kept = keepSetup(input({ skills: [x, y] }), refuse, home);
    expect(kept.reads).toEqual([join(home, '.claude/skills'), join(outside, 'x')]);
  });

  it('lists the .env files under every read as secrets to deny', () => {
    const s = builderSkill('s');
    writeFileSync(join(home, '.claude/skills/s/.env'), 'TOKEN=x');
    const kept = keepSetup(input({ skills: [s] }), refuse, home);
    expect(kept.secretFiles).toEqual([join(home, '.claude/skills/s/.env')]);
  });

  it('lists a .env directory under a read as one secret, and a folder in it that can’t be listed keeps the skill', () => {
    const s = builderSkill('s');
    const secret = join(home, '.claude/skills/s/.env.d');
    mkdirSync(join(secret, 'locked'), { recursive: true });
    writeFileSync(join(secret, 'prod'), 'TOKEN=x');
    chmodSync(join(secret, 'locked'), 0o000);
    unlistable.push(join(secret, 'locked'));
    const kept = keepSetup(input({ skills: [s] }), refuse, home);
    expect(kept.keptSkills).toEqual([s]);
    expect(kept.secretFiles).toEqual([secret]);
  });

  it('names the target of every link inside a .env directory as a secret, entering no linked folder', () => {
    const s = builderSkill('s');
    const secret = join(home, '.claude/skills/s/.env');
    mkdirSync(join(secret, 'deep'), { recursive: true });
    const key = join(home, '.claude/skills/s/prod.key');
    writeFileSync(key, 'KEY');
    const pem = join(outside, 'k.pem');
    writeFileSync(pem, 'PEM');
    symlinkSync(key, join(secret, 'creds'));
    symlinkSync(pem, join(secret, 'deep', 'k'));
    // A folder link back to the .env folder: a walk that entered it would never end.
    symlinkSync(secret, join(secret, 'deep', 'loop'));
    const kept = keepSetup(input({ skills: [s] }), refuse, home);
    expect(kept.keptSkills).toEqual([s]);
    expect(kept.secretFiles).toEqual([secret, pem, key].sort());
  });

  it('writes the project’s copies under project/', () => {
    const made = createSetupDir(
      filesRoot,
      input({
        projectFiles: [
          {
            relative: 'skills/p/SKILL.md',
            content: Buffer.from('---\nname: p\n---\n'),
            mode: 0o600,
          },
          { relative: 'skills/p/run.sh', content: Buffer.from('#!/bin/sh\n'), mode: 0o700 },
          { relative: 'commands/c.md', content: Buffer.from('c'), mode: 0o600 },
        ],
      }),
      refuse,
      home,
    );
    const project = made.setup.pluginDirs[0] ?? '';
    expect(project).toMatch(/\/project$/);
    expect(made.setup.pluginDirs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(project, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'project',
    });
    expect(readFileSync(join(project, 'commands/c.md'), 'utf8')).toBe('c');
    expect(statSync(join(project, 'skills/p/run.sh')).mode & 0o777).toBe(0o700);
    expect(statSync(join(project, 'skills/p')).mode & 0o777).toBe(0o700);
    expect(made.setup.skillRoots).toEqual([join(project, 'skills')]);
    made.remove();
  });

  it('wraps each kept plugin and never passes its install path', () => {
    const plugin = join(home, '.claude/plugins/cache/m/p/1');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
    skillAt(join(plugin, 'skills/x'));
    writeFileSync(join(plugin, '.mcp.json'), '{}');
    const made = createSetupDir(
      filesRoot,
      input({ plugins: [{ id: 'p@m', path: plugin }] }),
      refuse,
      home,
    );
    const wrapper = made.setup.pluginDirs[0] ?? '';
    expect(made.setup.pluginDirs).toEqual([join(made.setup.reads[0] ?? '', 'plugins/p')]);
    expect(readlinkSync(join(wrapper, 'skills'))).toBe(join(plugin, 'skills'));
    expect(existsSync(join(wrapper, '.mcp.json'))).toBe(false);
    expect(made.setup.skillRoots).toEqual([join(plugin, 'skills')]);
    expect(made.setup.loaded.plugins).toEqual(['p@m']);
    made.remove();
  });

  it.skipIf(process.platform !== 'darwin')(
    'leaves out a second skill or plugin whose name differs only by case, in the preview and the dir',
    () => {
      const upper = builderSkill('Review');
      const lower = {
        ...builderSkill('review', skillAt(join(outside, 'review'))),
        path: join(outside, 'review'),
      };
      const plugin = (name: string) => {
        const path = join(home, '.claude/plugins/cache/m', name, '1');
        mkdirSync(join(path, '.claude-plugin'), { recursive: true });
        writeFileSync(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
        return path;
      };
      const setup = input({
        skills: [upper, lower],
        plugins: [
          { id: 'Foo@m1', path: plugin('Foo') },
          { id: 'foo@m2', path: plugin('foo2') },
        ],
      });
      const leftOut = [
        { what: shownOutside('review'), why: 'a skill named Review is already loaded' },
        { what: 'foo@m2', why: 'a plugin named Foo is already loaded' },
      ];
      const kept = keepSetup(setup, refuse, home);
      expect(kept.keptSkills).toEqual([upper]);
      expect(kept.keptPlugins.map((p) => p.id)).toEqual(['Foo@m1']);
      expect(kept.leftOut).toEqual(leftOut);
      const made = createSetupDir(filesRoot, setup, refuse, home);
      expect(made.setup.loaded).toEqual({ skills: ['Review'], plugins: ['Foo@m1'] });
      expect(made.setup.leftOut).toEqual(leftOut);
      made.remove();
    },
  );

  it('remove() leaves nothing', () => {
    const made = createSetupDir(filesRoot, input({ skills: [builderSkill('s')] }), refuse, home);
    const dir = join(made.setup.pluginDirs[0] ?? '', '..');
    expect(made.setup.reads[0]).toBe(dir);
    made.remove();
    expect(existsSync(dir)).toBe(false);
  });
});
