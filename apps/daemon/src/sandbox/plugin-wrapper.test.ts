import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tempDir, type TempDir } from '../../test/fixtures';
import { wrapPlugin } from './plugin-wrapper';
import { singleQuoted } from './posix-quote';

const EmittedHooks = z.object({
  hooks: z.object({
    SessionStart: z.array(
      z.object({ hooks: z.array(z.object({ command: z.string().optional() })) }),
    ),
  }),
});

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
    wrapPlugin(plugin, into);
    expect(JSON.parse(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'p',
      version: '1.0.0',
      description: 'a plugin',
    });
    for (const entry of ['skills', 'agents', 'commands'])
      expect(readlinkSync(join(into, entry))).toBe(join(plugin, entry));
  });

  it('leaves out .mcp.json and the manifest’s mcpServers', () => {
    const { leftOut } = wrapPlugin(plugin, into);
    expect(existsSync(join(into, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(into, '.claude-plugin/plugin.json'), 'utf8')).not.toContain('evil');
    expect(leftOut).toEqual([
      {
        what: 'p: hooks, commands in its manifest',
        why: 'the wrapper lays out only the default folders',
      },
    ]);
  });

  it('starts every command hook in the plugin’s folder', () => {
    wrapPlugin(plugin, into);
    const emitted: unknown = JSON.parse(readFileSync(join(into, 'hooks/hooks.json'), 'utf8'));
    expect(emitted).toEqual({
      description: 'h',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: `cd ${singleQuoted(into)} && npx thing`, timeout: 5 },
              { type: 'prompt', prompt: 'say hi' },
            ],
          },
        ],
      },
    });
  });

  it('keeps the hook scripts reachable through CLAUDE_PLUGIN_ROOT', () => {
    wrapPlugin(plugin, into);
    expect(readlinkSync(join(into, 'hooks/run.sh'))).toBe(join(plugin, 'hooks/run.sh'));
    const ran = spawnSync('/bin/sh', ['-c', '"$CLAUDE_PLUGIN_ROOT/hooks/run.sh"'], {
      env: { PATH: '/usr/bin:/bin', CLAUDE_PLUGIN_ROOT: into },
      encoding: 'utf8',
    });
    expect(ran.stdout).toBe('ran\n');
  });

  it('leaves out the hooks of a hooks.json that does not parse, and lists them', () => {
    write(join(plugin, 'hooks/hooks.json'), '{"hooks": [1, 2]}');
    const { leftOut } = wrapPlugin(plugin, into);
    expect(existsSync(join(into, 'hooks/hooks.json'))).toBe(false);
    expect(leftOut).toContainEqual({
      what: "p's hooks",
      why: 'its hooks.json is not a shape 10db reads',
    });
  });

  it('a command hook run from the wrapper with the checkout as cwd resolves npx from the plugin, not the checkout', () => {
    wrapPlugin(plugin, into);
    const checkout = join(root.path, 'checkout');
    const marker = join(checkout, 'marker');
    write(
      join(checkout, 'node_modules/.bin/thing'),
      `#!/bin/sh\ntouch ${singleQuoted(marker)}\n`,
      0o755,
    );
    // npx runs a package's bin from the working directory's node_modules before any download.
    const bin = join(root.path, 'bin');
    write(join(bin, 'npx'), '#!/bin/sh\nexec "./node_modules/.bin/$1"\n', 0o755);
    const emitted = EmittedHooks.parse(
      JSON.parse(readFileSync(join(into, 'hooks/hooks.json'), 'utf8')),
    );
    const command = emitted.hooks.SessionStart[0]?.hooks[0]?.command ?? '';
    spawnSync('/bin/sh', ['-c', command], {
      cwd: checkout,
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: into },
    });
    expect(existsSync(marker)).toBe(false);
  });
});
