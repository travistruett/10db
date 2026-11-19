import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readPluginManifest } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { SandboxProfileError } from './profile';
import { homeProtectedReads } from './protected-reads';
import { createSetupDir, keepSetup, type KeptSetup, type SetupJudge } from './setup-dir';
import type { SetupInput } from './setup-input';
import { holdsSessionGround, setupReadRefusal, type SetupReadContext } from './setup-reads';

let root: TempDir;
let home: string;
let outside: string;
let checkout: string;
let filesRoot: string;
let ctx: SetupReadContext;

const judge: SetupJudge = {
  refuse: (real) => setupReadRefusal(real, ctx),
  holdsSessionGround: (real) => holdsSessionGround(real, ctx),
  isCheckoutSecret: () => false,
};
const UNNAMEABLE =
  "a path in it holds a character the sandbox profile can't take ([ ] * ? { } \\ or a line break)";

function freshContext(): SetupReadContext {
  return {
    home,
    protectedReads: homeProtectedReads(home),
    secretFiles: [],
    sandboxRoots: [filesRoot],
    laneWritable: [checkout],
  };
}

beforeEach(() => {
  root = tempDir('setup-dir');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  outside = join(base, 'outside');
  checkout = join(base, 'checkout');
  filesRoot = join(base, 'files');
  for (const dir of [home, outside, checkout, filesRoot]) mkdirSync(dir);
  ctx = freshContext();
});

/** Folders a row made unlistable, given back so the temp dir can go. */
const unlistable: string[] = [];

afterEach(() => {
  for (const locked of unlistable.splice(0)) chmodSync(locked, 0o700);
  root.cleanup();
});

/** Empties the home, the outside folder and the checkout, and restores the context, for the next row. */
function reset(): void {
  for (const locked of unlistable.splice(0)) chmodSync(locked, 0o700);
  for (const dir of [home, outside, checkout]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  ctx = freshContext();
}

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

/** A setup laid out on disk, and what `keepSetup` must make of it. */
interface Row {
  name: string;
  make: () => {
    setup: SetupInput;
    expected: Partial<
      Pick<
        KeptSetup,
        'keptSkills' | 'keptPlugins' | 'keptProjectFiles' | 'leftOut' | 'reads' | 'secretFiles'
      >
    >;
    judge?: SetupJudge;
  };
}

/** Lays out each row on an emptied home and checks every field it names. */
function judgeRows(rows: Row[]): void {
  for (const row of rows) {
    reset();
    const made = row.make();
    const kept = keepSetup(made.setup, made.judge ?? judge, home);
    for (const [key, value] of Object.entries(made.expected)) {
      expect.soft(kept[key as keyof typeof made.expected], `${row.name}: ${key}`).toEqual(value);
    }
  }
}

describe('keepSetup and createSetupDir', () => {
  it('links each kept skill under yours/skills, writes the manifest, and remove() leaves nothing', () => {
    const s = builderSkill('s');
    const made = createSetupDir(filesRoot, input({ skills: [s] }), judge, home);
    const yours = made.setup.pluginDirs[0] ?? '';
    expect(yours).toMatch(/\/10db-setup-[0-9a-f]{12}\/yours$/);
    expect(readlinkSync(join(yours, 'skills/s'))).toBe(join(home, '.claude/skills/s'));
    expect(JSON.parse(readFileSync(join(yours, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'yours',
    });
    expect(made.setup.skillRoots).toEqual([join(yours, 'skills')]);
    expect(made.setup.loaded).toEqual({ skills: ['s'], plugins: [] });
    expect(made.setup.leftOut).toEqual([]);
    const dir = join(yours, '..');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(made.setup.reads[0]).toBe(dir);
    made.remove();
    expect(existsSync(dir)).toBe(false);
  });

  it('leaves out a skill, plugin or project file it may not open, naming why, and keeps the rest', () => {
    // The harness plugin's own name is one of those reserved below.
    expect(readPluginManifest().name).toBe('10db-harness');
    const rows: Row[] = [
      {
        name: 'a skill linked to a hidden folder of the home',
        make: () => {
          mkdirSync(join(home, '.ssh'));
          const ssh = linkedSkill('ssh', join(home, '.ssh'));
          return {
            setup: input({ skills: [ssh] }),
            expected: {
              keptSkills: [],
              leftOut: [
                {
                  what: '~/.claude/skills/ssh',
                  why: 'it lies under ~/Library or a hidden folder of your home',
                },
              ],
              reads: [],
            },
          };
        },
      },
      {
        name: 'a skill whose SKILL.md leads into a checkout',
        make: () => {
          writeFileSync(join(checkout, 'SKILL.md'), 'lane written');
          const dir = join(home, '.claude/skills/s');
          mkdirSync(dir, { recursive: true });
          symlinkSync(join(checkout, 'SKILL.md'), join(dir, 'SKILL.md'));
          const s = { name: 's', path: dir, skillFile: join(checkout, 'SKILL.md') };
          return {
            setup: input({ skills: [s] }),
            expected: {
              keptSkills: [],
              leftOut: [
                {
                  what: '~/.claude/skills/s',
                  why: 'it lies in, or holds, a folder a lane can write',
                },
              ],
              reads: [],
            },
          };
        },
      },
      {
        name: 'a plugin whose folder is gone',
        make: () => ({
          setup: input({
            plugins: [{ id: 'p@m', path: join(home, '.claude/plugins/cache/m/p/1') }],
          }),
          expected: {
            keptPlugins: [],
            leftOut: [{ what: 'p@m', why: 'its folder is gone; Claude Code may have updated it' }],
          },
        }),
      },
      {
        name: 'a skill holding a folder that can’t be listed',
        make: () => {
          const s = builderSkill('s');
          const t = builderSkill('t');
          const locked = join(home, '.claude/skills/t/locked');
          mkdirSync(locked);
          chmodSync(locked, 0o000);
          unlistable.push(locked);
          return {
            setup: input({ skills: [s, t] }),
            expected: {
              keptSkills: [s],
              leftOut: [
                { what: '~/.claude/skills/t', why: "a folder in it can't be listed: locked" },
              ],
              reads: [join(home, '.claude/skills/s')],
            },
          };
        },
      },
      {
        name: 'a skill whose folder the profile could not name, as a link target outside the roots',
        make: () => {
          const odd = linkedSkill('a', join(outside, 'my[skills]/a'));
          const s = builderSkill('s');
          return {
            setup: input({ skills: [odd, s] }),
            expected: {
              keptSkills: [s],
              leftOut: [{ what: '~/.claude/skills/a', why: UNNAMEABLE }],
              reads: [join(home, '.claude/skills')],
            },
          };
        },
      },
      ...[
        ['a glob character', 'app/[slug]'],
        ['a star', 'a*b'],
        ['a line break', 'line\nbreak'],
      ].map(([what, folder]): Row => ({
        name: `a skill holding a .env path with ${String(what)}`,
        make: () => {
          const s = builderSkill('s');
          writeFileSync(
            join(skillAt(join(home, '.claude/skills/s', String(folder))), '.env.example'),
            'X=1',
          );
          const t = builderSkill('t');
          return {
            setup: input({ skills: [s, t] }),
            expected: {
              keptSkills: [t],
              leftOut: [{ what: '~/.claude/skills/s', why: UNNAMEABLE }],
              reads: [join(home, '.claude/skills/t')],
              secretFiles: [],
            },
          };
        },
      })),
      ...(
        [
          ['a checkout', () => checkout],
          ['the home', () => home],
          ['/', () => '/'],
        ] as const
      ).map(([what, target]): Row => ({
        name: `a skill whose .env link leads to ${what}, never closing it`,
        make: () => {
          const s = builderSkill('s');
          symlinkSync(target(), join(home, '.claude/skills/s/.env'));
          const t = builderSkill('t');
          return {
            setup: input({ skills: [s, t] }),
            expected: {
              keptSkills: [t],
              leftOut: [
                {
                  what: '~/.claude/skills/s',
                  why: 'a .env link in it leads to a folder the session needs, which 10db would have to close',
                },
              ],
              secretFiles: [],
            },
          };
        },
      })),
      ...['yours@m', 'project@m', '10db-harness@m', 'Yours@m'].map((id): Row => ({
        name: `a plugin named as 10db’s own setup is: ${id}`,
        make: () => {
          const path = join(home, '.claude/plugins/cache/m', id, '1');
          mkdirSync(path, { recursive: true });
          return {
            setup: input({ plugins: [{ id, path }] }),
            expected: {
              keptPlugins: [],
              leftOut: [{ what: id, why: "its name is one 10db's own setup uses" }],
            },
          };
        },
      })),
      {
        name: 'a project file the checkout holds as a secret',
        make: () => {
          const files = [
            { relative: 'skills/p/SKILL.md', source: '.claude/skills/p/SKILL.md' },
            { relative: 'skills/p/key.txt', source: '.claude/skills/p/key.txt' },
          ].map((file) => ({ ...file, content: Buffer.from('x'), mode: 0o600 }));
          // The checkout's `.env` is a link to the skill's key.txt, so key.txt is a checkout secret.
          const isSecret = (source: string): boolean => source === '.claude/skills/p/key.txt';
          return {
            setup: input({ projectFiles: files }),
            judge: { ...judge, isCheckoutSecret: isSecret },
            expected: {
              keptProjectFiles: files.slice(0, 1),
              leftOut: [
                { what: '.claude/skills/p/key.txt', why: 'a secrets file is never copied' },
              ],
            },
          };
        },
      },
      {
        name: 'a builder skill whose frontmatter it cannot read and that could name MCP servers',
        make: () => {
          const dir = skillAt(join(home, '.claude/skills/s'));
          writeFileSync(join(dir, 'SKILL.md'), '---\nname: s\n"\\x6dcpServers": [\n---\nBody\n');
          return {
            setup: input({ skills: [builderSkill('s', dir)] }),
            expected: {
              keptSkills: [],
              leftOut: [
                {
                  what: '~/.claude/skills/s',
                  why: 'left out: its frontmatter is not YAML 10db reads, and it may hold MCP servers',
                },
              ],
            },
          };
        },
      },
    ];
    judgeRows(rows);
  });

  it('opens the fewest folders that hold every kept skill and plugin, by their real paths', () => {
    judgeRows([
      {
        name: 'no skill kept opens no root',
        make: () => {
          builderSkill('s');
          skillAt(join(home, '.agents/skills/t'));
          return { setup: input(), expected: { reads: [] } };
        },
      },
      {
        name: 'one skill opens ~/.claude/skills',
        make: () => ({
          setup: input({ skills: [builderSkill('s')] }),
          expected: { reads: [join(home, '.claude/skills')] },
        }),
      },
      {
        name: 'a skill whose SKILL.md leads into another skill folder reads that folder',
        make: () => {
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
          // ~/.claude/skills holds only the link, so it stays closed: the kernel judges the real path.
          return {
            setup: input({ skills: [s] }),
            expected: { keptSkills: [s], reads: [a, join(outside, 'b')] },
          };
        },
      },
      {
        name: 'every child passing opens ~/.claude/skills whole',
        make: () => {
          const s = builderSkill('s');
          const t = builderSkill('t');
          const plugin = join(home, '.claude/plugins/cache/m/p/1');
          mkdirSync(plugin, { recursive: true });
          return {
            setup: input({ skills: [s, t], plugins: [{ id: 'p@m', path: plugin }] }),
            expected: { reads: [plugin, join(home, '.claude/skills')] },
          };
        },
      },
      {
        name: '200 skills and one refused link still open the root whole',
        make: () => {
          const skills = Array.from({ length: 200 }, (_, i) => builderSkill(`s${String(i)}`));
          mkdirSync(join(home, '.ssh'));
          const ssh = linkedSkill('ssh', join(home, '.ssh'));
          return {
            setup: input({ skills: [...skills, ssh] }),
            expected: { keptSkills: skills, reads: [join(home, '.claude/skills')] },
          };
        },
      },
      {
        name: 'a refused real directory in the root opens the passing folders one by one',
        make: () => {
          const s = builderSkill('s');
          const bad = builderSkill('bad');
          ctx = { ...ctx, laneWritable: [...ctx.laneWritable, join(home, '.claude/skills/bad')] };
          return {
            setup: input({ skills: [s, bad] }),
            expected: { keptSkills: [s], reads: [join(home, '.claude/skills/s')] },
          };
        },
      },
      {
        name: 'link targets outside the roots collapse',
        make: () => {
          const x = linkedSkill('x', join(outside, 'x'));
          skillAt(join(outside, 'x/inner'));
          const dir = join(home, '.claude/skills/y');
          mkdirSync(dir);
          symlinkSync(join(outside, 'x/inner/SKILL.md'), join(dir, 'SKILL.md'));
          const y = { name: 'y', path: dir, skillFile: join(outside, 'x/inner/SKILL.md') };
          return {
            setup: input({ skills: [x, y] }),
            expected: { reads: [join(home, '.claude/skills'), join(outside, 'x')] },
          };
        },
      },
    ]);
  });

  it('lists every .env and .git under an opened read as a secret to deny, entering no linked folder', () => {
    judgeRows([
      {
        name: 'a .env file',
        make: () => {
          const s = builderSkill('s');
          writeFileSync(join(home, '.claude/skills/s/.env'), 'TOKEN=x');
          return {
            setup: input({ skills: [s] }),
            expected: { secretFiles: [join(home, '.claude/skills/s/.env')] },
          };
        },
      },
      {
        name: 'a .env directory as one secret, a folder in it that can’t be listed keeping the skill',
        make: () => {
          const s = builderSkill('s');
          const secret = join(home, '.claude/skills/s/.env.d');
          mkdirSync(join(secret, 'locked'), { recursive: true });
          writeFileSync(join(secret, 'prod'), 'TOKEN=x');
          chmodSync(join(secret, 'locked'), 0o000);
          unlistable.push(join(secret, 'locked'));
          return {
            setup: input({ skills: [s] }),
            expected: { keptSkills: [s], secretFiles: [secret] },
          };
        },
      },
      {
        name: 'the target of every link inside a .env directory',
        make: () => {
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
          return {
            setup: input({ skills: [s] }),
            expected: { keptSkills: [s], secretFiles: [secret, pem, key].sort() },
          };
        },
      },
      {
        name: 'a .git folder, as a remote token may be in it',
        make: () => {
          const s = builderSkill('s');
          mkdirSync(join(home, '.claude/skills/s/.git'));
          writeFileSync(join(home, '.claude/skills/s/.git/config'), '[remote "o"]\n');
          return {
            setup: input({ skills: [s] }),
            expected: { keptSkills: [s], secretFiles: [join(home, '.claude/skills/s/.git')] },
          };
        },
      },
    ]);
  });

  it('writes the project’s copies under project/', () => {
    const made = createSetupDir(
      filesRoot,
      input({
        projectFiles: [
          {
            relative: 'skills/p/SKILL.md',
            source: '.claude/skills/p/SKILL.md',
            content: Buffer.from('---\nname: p\n---\n'),
            mode: 0o600,
          },
          {
            relative: 'skills/p/run.sh',
            source: '.claude/skills/p/run.sh',
            content: Buffer.from('#!/bin/sh\n'),
            mode: 0o700,
          },
          {
            relative: 'commands/c.md',
            source: '.claude/commands/c.md',
            content: Buffer.from('c'),
            mode: 0o600,
          },
        ],
      }),
      judge,
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
      judge,
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
      const kept = keepSetup(setup, judge, home);
      expect(kept.keptSkills).toEqual([upper]);
      expect(kept.keptPlugins.map((p) => p.id)).toEqual(['Foo@m1']);
      expect(kept.leftOut).toEqual(leftOut);
      const made = createSetupDir(filesRoot, setup, judge, home);
      expect(made.setup.loaded).toEqual({ skills: ['Review'], plugins: ['Foo@m1'] });
      expect(made.setup.leftOut).toEqual(leftOut);
      made.remove();
    },
  );

  it('a setup dir it cannot write refuses with a typed error and leaves nothing', () => {
    const escape = {
      relative: '../x',
      source: '.claude/x',
      content: Buffer.from('x'),
      mode: 0o600,
    };
    expect(() => createSetupDir(filesRoot, input({ projectFiles: [escape] }), judge, home)).toThrow(
      SandboxProfileError,
    );
    expect(readdirSync(filesRoot)).toEqual([]);
  });

  // The builder installed it: a skill's hooks and pre-approved tools run as in Claude Code.
  it('links a builder skill whose SKILL.md holds hooks or allowed-tools as written', () => {
    for (const [name, keys] of [
      ['hooks', 'hooks:\n  PreToolUse: []\n'],
      ['allowed-tools', 'allowed-tools: Bash\n'],
    ]) {
      reset();
      const dir = skillAt(join(home, '.claude/skills/s'));
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: s\n${String(keys)}---\nBody\n`);
      const s = builderSkill('s', dir);
      expect.soft(keepSetup(input({ skills: [s] }), judge, home).leftOut, name).toEqual([]);
      const made = createSetupDir(filesRoot, input({ skills: [s] }), judge, home);
      const linked = join(made.setup.pluginDirs[0] ?? '', 'skills/s');
      expect.soft(readlinkSync(linked), name).toBe(realpathSync(dir));
      expect.soft(made.setup.loaded.skills, name).toEqual(['s']);
      made.remove();
    }
  });

  it('lays out a builder skill whose SKILL.md holds mcpServers as links, the SKILL.md re-emitted without it', () => {
    const dir = skillAt(join(home, '.claude/skills/s'));
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: s\nmcpServers: {}\n---\nBody !`date`\n');
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n');
    const s = builderSkill('s', dir);
    const leftOut = [
      {
        what: '~/.claude/skills/s',
        why: 'MCP servers in a definition are stripped; your own servers come from Settings › Trust',
      },
    ];
    // The Settings preview names it as the session does.
    expect(keepSetup(input({ skills: [s] }), judge, home).leftOut).toEqual(leftOut);
    const made = createSetupDir(filesRoot, input({ skills: [s] }), judge, home);
    const linked = join(made.setup.pluginDirs[0] ?? '', 'skills/s');
    expect(readFileSync(join(linked, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: s\n---\nBody !`date`\n',
    );
    expect(readlinkSync(join(linked, 'run.sh'))).toBe(join(dir, 'run.sh'));
    expect(made.setup.leftOut).toEqual(leftOut);
    made.remove();
  });
});
