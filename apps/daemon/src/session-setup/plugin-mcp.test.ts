import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { readPluginMcp } from './plugin-mcp';
import { readYourMcpConfig } from './your-mcp-config';

let root: TempDir;
let installPath: string;

beforeEach(() => {
  root = tempDir('plugin-mcp');
  installPath = join(realpathSync(root.path), 'cache', 'm', 'github', '1.0.0');
  mkdirSync(installPath, { recursive: true });
});

afterEach(() => {
  root.cleanup();
});

function write(relative: string, content: unknown): void {
  const path = join(installPath, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const read = (id = 'github@m', laneWritable: readonly string[] = []) =>
  readPluginMcp({ id, installPath }, laneWritable);

describe('readPluginMcp', () => {
  it('reads a plugin’s .mcp.json server, CLAUDE_PLUGIN_ROOT expanded in its command and env', () => {
    write('.mcp.json', {
      mcpServers: {
        gh: {
          command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
          args: ['--root', '${CLAUDE_PLUGIN_ROOT}/data'],
          env: { DATA: '${CLAUDE_PLUGIN_ROOT}/db' },
        },
      },
    });
    const [entry, ...rest] = read();
    expect(rest).toEqual([]);
    expect(entry?.refusal).toBeNull();
    expect(entry?.declared).toMatchObject({
      transport: 'stdio',
      command: `${installPath}/bin/server`,
      args: ['--root', `${installPath}/data`],
      env: { DATA: `${installPath}/db`, CLAUDE_PLUGIN_ROOT: installPath },
    });
  });

  it('names it plugin_<plugin>_<server>, keyed by plugin and server', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x' } } });
    expect(read().map((e) => [e.name, e.key, e.source, e.pluginId])).toEqual([
      ['plugin_github_gh', 'plugin:github%40m:gh', 'plugin', 'github@m'],
    ]);
  });

  it('a plugin server whose session name fails McpServerName is refused with that reason, and the rest load', () => {
    write('.mcp.json', {
      mcpServers: { ['x'.repeat(80)]: { command: 'x' }, ok: { command: 'x' } },
    });
    const entries = read();
    expect(entries.map((e) => e.refusal)).toEqual(["Its name can't be an MCP server name.", null]);
  });

  it('reads inline mcpServers from plugin.json', () => {
    write('.claude-plugin/plugin.json', {
      name: 'github',
      mcpServers: { inline: { type: 'http', url: 'https://mcp.example/mcp' } },
    });
    expect(read().map((e) => [e.name, e.refusal])).toEqual([['plugin_github_inline', null]]);
  });

  it('reads a plugin.json mcpServers path inside the plugin', () => {
    write('.claude-plugin/plugin.json', { name: 'github', mcpServers: './servers.json' });
    write('servers.json', { mcpServers: { viaPath: { command: 'x' } } });
    expect(read().map((e) => e.name)).toEqual(['plugin_github_viaPath']);
  });

  it('a plugin.json mcpServers path outside the plugin loads nothing', () => {
    write('.claude-plugin/plugin.json', { name: 'github', mcpServers: '../../../outside.json' });
    writeFileSync(
      join(installPath, '..', '..', '..', 'outside.json'),
      '{"mcpServers":{"o":{"command":"x"}}}',
    );
    expect(read()).toEqual([]);
  });

  it('a link in the plugin’s .mcp.json loads nothing', () => {
    writeFileSync(join(root.path, 'real.json'), '{"mcpServers":{"a":{"command":"x"}}}');
    symlinkSync(join(root.path, 'real.json'), join(installPath, '.mcp.json'));
    expect(read()).toEqual([]);
  });

  it('${TOKEN} in a plugin server’s argument is refused, and the server’s own name is kept', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x', args: ['--k=${TOKEN}'] } } });
    expect(read()[0]?.refusal).toContain('Its argument 1 uses ${…}');
  });

  it('a plugin installed where an agent can write is one refused entry and its files are not read', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x' } } });
    const entries = read('github@m', [join(installPath, '..')]);
    expect(entries.map((e) => [e.name, e.declared, e.refusal])).toEqual([
      [
        'plugin_github',
        null,
        'Its plugin is installed in a folder an agent can write, so none of its MCP servers load.',
      ],
    ]);
  });

  it('a plugin whose folder holds a folder an agent can write is refused too', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x' } } });
    mkdirSync(join(installPath, 'sub'));
    expect(read('github@m', [join(installPath, 'sub')]).map((e) => e.declared)).toEqual([null]);
  });

  it('a plugin whose install path links into a folder an agent can write is refused too', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x' } } });
    const outside = join(root.path, 'writable');
    mkdirSync(outside);
    const linked = join(root.path, 'linked-plugin');
    symlinkSync(installPath, linked);
    const entries = readPluginMcp({ id: 'github@m', installPath: linked }, [installPath]);
    expect(entries.map((e) => e.refusal)).toEqual([
      'Its plugin is installed in a folder an agent can write, so none of its MCP servers load.',
    ]);
  });

  it('a .mcp.json with no servers key, or not JSON, is no entries', () => {
    write('.mcp.json', '{"mcpServers": {"a": {"env": {"T": "sk-canary"');
    expect(read()).toEqual([]);
  });
});

describe('readYourMcpConfig with plugins', () => {
  it('adds the entries of the plugins it is given', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x' } } });
    const home = join(root.path, 'home');
    mkdirSync(home);
    const { entries } = readYourMcpConfig({
      home,
      laneWritable: [],
      plugins: [{ id: 'github@m', installPath }],
    });
    expect(entries.map((e) => e.name)).toEqual(['plugin_github_gh']);
  });
});
