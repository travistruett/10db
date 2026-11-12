import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { carriedEntries, wrapPlugin } from './plugin-wrapper';
import { pluginChanges } from './setup-definitions';

let root: TempDir;
let plugin: string;
let into: string;

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function hooksJson(command: string): string {
  return JSON.stringify({
    description: 'h',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            { type: 'command', command, timeout: 5 },
            { type: 'prompt', prompt: 'say hi' },
          ],
        },
      ],
    },
  });
}

beforeEach(() => {
  root = tempDir('plugin-wrapper');
  const base = realpathSync(root.path);
  plugin = join(base, 'cache/m/p/1');
  into = join(base, 'setup/plugins/p');
  mkdirSync(into, { recursive: true });
  write(
    join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: 'p',
      version: '1.0.0',
      description: 'a plugin',
      author: { name: 'x' },
      mcpServers: { s: { command: 'evil' } },
      hooks: './elsewhere.json',
      commands: './custom',
    }),
  );
  write(join(plugin, 'skills/x/SKILL.md'), '---\nname: x\n---\n');
  write(join(plugin, 'agents/a.md'), 'a');
  write(join(plugin, 'commands/c.md'), 'c');
  write(join(plugin, '.mcp.json'), '{"mcpServers":{"s":{"command":"evil"}}}');
  write(join(plugin, 'hooks/hooks.json'), hooksJson('npx thing'));
  write(join(plugin, 'hooks/run.sh'), '#!/bin/sh\necho ran\n', 0o755);
});

afterEach(() => {
  root.cleanup();
});

describe('wrapPlugin', () => {
  it('keeps the plugin’s name and links its skills, agents and commands', () => {
    wrapPlugin(plugin, into, []);
    expect(JSON.parse(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'p',
      version: '1.0.0',
      description: 'a plugin',
    });
    for (const entry of ['skills', 'agents', 'commands'])
      expect(readlinkSync(join(into, entry))).toBe(join(plugin, entry));
  });

  // APFS folds case and Unicode normalization, so Claude Code's read of hooks/hooks.json or .mcp.json
  // would reach an entry spelled another way.
  it.each<[string, () => void, string]>([
    [
      'a .MCP.json',
      () => {
        rmSync(join(plugin, '.mcp.json'));
        write(join(plugin, '.MCP.json'), '{"mcpServers":{"s":{"command":"evil"}}}');
      },
      '.mcp.json',
    ],
    [
      'an entry spelled in NFD',
      () => {
        // Written decomposed, looked up composed: APFS finds one by the other.
        write(join(plugin, 'e\u0301tc/run.sh'), '#!/bin/sh\n', 0o755);
      },
      '\u00e9tc',
    ],
  ])('carries nothing of %s into the wrapper', (_name, arrange, unwanted) => {
    arrange();
    wrapPlugin(plugin, into, []);
    expect(existsSync(join(into, unwanted))).toBe(false);
    expect(readdirSync(into).sort()).toEqual([
      '.claude-plugin',
      'agents',
      'commands',
      'hooks',
      'skills',
    ]);
  });

  it('re-emits hooks.json with each command started in the wrapper’s folder, and links the scripts', () => {
    wrapPlugin(plugin, into, []);
    const emitted: unknown = JSON.parse(readFileSync(join(into, 'hooks/hooks.json'), 'utf8'));
    expect(emitted).toEqual({
      description: 'h',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: `cd '${into}' && npx thing`, timeout: 5 },
              { type: 'prompt', prompt: 'say hi' },
            ],
          },
        ],
      },
    });
    expect(readlinkSync(join(into, 'hooks/run.sh'))).toBe(join(plugin, 'hooks/run.sh'));
  });

  it('re-emits a Hooks folder spelled in another case under hooks, once', () => {
    rmSync(join(plugin, 'hooks'), { recursive: true });
    write(join(plugin, 'Hooks/Hooks.json'), hooksJson('npx thing'));
    wrapPlugin(plugin, into, []);
    expect(readdirSync(into).filter((entry) => entry.toLowerCase() === 'hooks')).toEqual(['hooks']);
    expect(readFileSync(join(into, 'hooks/hooks.json'), 'utf8')).toContain(
      JSON.stringify(`cd '${into}' && npx thing`),
    );
  });

  it('lists a hooks.json it cannot read as left out', () => {
    write(join(plugin, 'hooks/hooks.json'), '{"hooks": 3}');
    expect(wrapPlugin(plugin, into, []).leftOut).toContainEqual({
      what: "p's hooks",
      why: 'its hooks.json is not a shape 10db reads',
    });
  });

  it('names the wrapper by its folder, the plugin id’s name, whatever the manifest says', () => {
    write(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'yours' }));
    wrapPlugin(plugin, into, []);
    expect(JSON.parse(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'p',
    });
  });

  it('leaves out .mcp.json and the manifest’s mcpServers', () => {
    const { leftOut } = wrapPlugin(plugin, into, []);
    expect(existsSync(join(into, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8')).not.toContain('evil');
    expect(leftOut).toEqual([
      {
        what: 'p: hooks, commands in its manifest',
        why: 'the wrapper lays out only the default folders',
      },
    ]);
  });

  it('lists no hooks for a plugin that has none', () => {
    rmSync(join(plugin, 'hooks'), { recursive: true });
    write(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
    expect(wrapPlugin(plugin, into, []).leftOut).toEqual([]);
  });

  /** Wraps the plugin as a session does: its definitions judged first, then laid out. */
  const wrap = () => {
    const changes = pluginChanges(plugin, carriedEntries(plugin));
    return { changes, leftOut: wrapPlugin(plugin, into, changes?.rewrites ?? []).leftOut };
  };

  // An agent's MCP servers would start servers 10db never launched, until Your MCP servers (T6).
  it.each<[string, string, string, string]>([
    [
      'an agent’s mcpServers',
      'agents/a.md',
      'mcpServers:\n  s: {command: evil}\n',
      'MCP servers arrive with Your MCP servers (T6)',
    ],
    [
      'a nested agent’s mcp_servers',
      'agents/sub/b.md',
      'mcp_servers: {}\n',
      'MCP servers arrive with Your MCP servers (T6)',
    ],
  ])('re-emits %s without it, keeping every other key and the body', (_name, file, keys, note) => {
    write(join(plugin, file), `---\nname: n\n${keys}description: d\n---\nBody !\`ls\`\n`);
    write(join(plugin, file, '..', 'helper.sh'), 'echo hi\n');
    const { changes } = wrap();
    expect(changes?.notes).toEqual([{ where: file, why: note }]);
    expect(readFileSync(join(into, file), 'utf8')).toBe(
      '---\nname: n\ndescription: d\n---\nBody !`ls`\n',
    );
    // The folder holding it is laid out as links; the definition beside it is linked as it was.
    expect(readlinkSync(join(into, file, '..', 'helper.sh'))).toBe(
      join(plugin, file, '..', 'helper.sh'),
    );
    expect(lstatSync(join(into, file, '..')).isSymbolicLink()).toBe(false);
  });

  // The builder installed the plugin: its definitions' hooks and pre-approved tools run as in Claude Code.
  it.each<[string, string, string]>([
    ['a skill’s hooks', 'skills/x/SKILL.md', 'hooks:\n  PreToolUse: []\n'],
    ['a skill’s allowed-tools', 'skills/x/SKILL.md', 'allowed-tools: Bash\n'],
    ['a command’s hooks', 'commands/c.md', 'hooks: {}\n'],
    ['an agent’s allowedTools', 'agents/a.md', 'allowedTools: Bash\n'],
  ])('links %s as written', (_name, file, keys) => {
    write(join(plugin, file), `---\nname: n\n${keys}---\nBody\n`);
    const { changes } = wrap();
    expect(changes).toEqual({ rewrites: [], notes: [] });
    expect(readFileSync(join(into, file), 'utf8')).toBe(`---\nname: n\n${keys}---\nBody\n`);
  });

  it('links a folder whose definitions hold none of it', () => {
    write(
      join(plugin, 'skills/x/SKILL.md'),
      '---\nname: x\ndescription: hooks are fine here\n---\n',
    );
    const { changes } = wrap();
    expect(changes).toEqual({ rewrites: [], notes: [] });
    expect(readlinkSync(join(into, 'skills'))).toBe(join(plugin, 'skills'));
  });

  it('leaves out a definition whose frontmatter it cannot read when its text could name a stripped key', () => {
    write(join(plugin, 'agents/a.md'), '---\nname: a\nmcpServers: [unclosed\n---\nBody\n');
    write(join(plugin, 'agents/b.md'), '---\nname: b\n---\nBody\n');
    const { changes } = wrap();
    expect(changes?.notes).toEqual([
      {
        where: 'agents/a.md',
        why: 'left out: its frontmatter is not YAML 10db reads, and it may hold MCP servers',
      },
    ]);
    expect(existsSync(join(into, 'agents/a.md'))).toBe(false);
    expect(readlinkSync(join(into, 'agents/b.md'))).toBe(join(plugin, 'agents/b.md'));
  });

  it('re-emits a definition under each path a folder link reaches it by', () => {
    write(join(plugin, 'shared/x.md'), '---\nname: x\nmcpServers: {}\n---\nBody\n');
    mkdirSync(join(plugin, 'commands/one'), { recursive: true });
    symlinkSync(join(plugin, 'shared'), join(plugin, 'commands/one/a'));
    symlinkSync(join(plugin, 'shared'), join(plugin, 'commands/b'));
    wrap();
    for (const path of ['commands/one/a/x.md', 'commands/b/x.md'])
      expect(readFileSync(join(into, path), 'utf8'), path).toBe('---\nname: x\n---\nBody\n');
  });

  it('leaves the plugin out when its definition folders nest past what 10db walks', () => {
    write(join(plugin, `commands/${'d/'.repeat(12)}x.md`), '---\nmcpServers: {}\n---\nBody\n');
    expect(pluginChanges(plugin, carriedEntries(plugin))).toBeNull();
  });

  it('leaves the plugin out when a folder link loops', () => {
    symlinkSync(join(plugin, 'commands'), join(plugin, 'commands/loop'));
    expect(pluginChanges(plugin, carriedEntries(plugin))).toBeNull();
  });
});
