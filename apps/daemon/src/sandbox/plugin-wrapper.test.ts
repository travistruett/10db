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
      'a Hooks folder holding hooks.json',
      () => {
        rmSync(join(plugin, 'hooks'), { recursive: true });
        write(join(plugin, 'Hooks/hooks.json'), hooksJson('npx thing'));
      },
      'hooks/hooks.json',
    ],
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
    expect(readdirSync(into).sort()).toEqual(['.claude-plugin', 'agents', 'commands', 'skills']);
  });

  it('leaves out .mcp.json and the manifest’s mcpServers', () => {
    const { leftOut } = wrapPlugin(plugin, into, []);
    expect(existsSync(join(into, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8')).not.toContain('evil');
    expect(leftOut).toEqual([
      {
        what: 'p: commands in its manifest',
        why: 'the wrapper lays out only the default folders',
      },
      { what: "p's hooks", why: "plugin hooks don't run in 10db sessions yet" },
    ]);
  });

  it('writes no hooks dir and lists the plugin’s hooks as left out', () => {
    const { leftOut } = wrapPlugin(plugin, into, []);
    expect(existsSync(join(into, 'hooks'))).toBe(false);
    expect(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8')).not.toContain('hooks');
    expect(leftOut).toContainEqual({
      what: "p's hooks",
      why: "plugin hooks don't run in 10db sessions yet",
    });
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

  // Research L3c: a skill's or command's hook and grant act outside 10db's guard and broker, an agent's
  // MCP servers would start servers 10db never launched.
  it.each<[string, string, string, string]>([
    ['a skill’s hooks', 'skills/x/SKILL.md', 'hooks:\n  PreToolUse: []\n', 'hooks left out'],
    [
      'a skill’s allowed-tools',
      'skills/x/SKILL.md',
      'allowed-tools: Bash\n',
      'pre-approved tools left out',
    ],
    ['a command’s hooks', 'commands/c.md', 'hooks: {}\n', 'hooks left out'],
    [
      'a nested command’s allowed-tools',
      'commands/sub/d.md',
      'allowed-tools: [Bash]\n',
      'pre-approved tools left out',
    ],
    [
      'an agent’s hooks and mcpServers',
      'agents/a.md',
      'hooks: {}\nmcpServers:\n  s: {command: evil}\n',
      'hooks left out, MCP servers left out',
    ],
    [
      'an agent’s allowedTools',
      'agents/a.md',
      'allowedTools: Bash\n',
      'pre-approved tools left out',
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
    write(join(plugin, 'agents/a.md'), '---\nname: a\nhooks: [unclosed\n---\nBody\n');
    write(join(plugin, 'agents/b.md'), '---\nname: b\n---\nBody\n');
    const { changes } = wrap();
    expect(changes?.notes).toEqual([
      {
        where: 'agents/a.md',
        why: 'left out: its frontmatter is not YAML 10db reads, and it may hold hooks or pre-approved tools',
      },
    ]);
    expect(existsSync(join(into, 'agents/a.md'))).toBe(false);
    expect(readlinkSync(join(into, 'agents/b.md'))).toBe(join(plugin, 'agents/b.md'));
  });
});
