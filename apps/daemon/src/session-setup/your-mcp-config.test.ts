import { mkdirSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { readYourMcpConfig, YOUR_MCP_FILE_MAX_BYTES, type YourMcpEntry } from './your-mcp-config';

let root: TempDir;
let home: string;
let checkout: string;

beforeEach(() => {
  root = tempDir('your-mcp-config');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(checkout);
});

afterEach(() => {
  root.cleanup();
});

const read = (): ReturnType<typeof readYourMcpConfig> =>
  readYourMcpConfig({ home, laneWritable: [checkout], plugins: [] });

function claudeJson(content: unknown): void {
  writeFileSync(
    join(home, '.claude.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

function codexToml(content: string): void {
  writeFileSync(join(home, '.codex', 'config.toml'), content);
}

const byName = (entries: readonly YourMcpEntry[], name: string): YourMcpEntry | undefined =>
  entries.find((e) => e.name === name);

const text = (value: unknown): string => JSON.stringify(value);

describe('readYourMcpConfig', () => {
  it('reads a stdio and an http server from ~/.claude.json and nothing else of the file', () => {
    claudeJson({
      primaryApiKey: 'sk-canary',
      projects: { [checkout]: { mcpServers: { local: { command: 'x' } } } },
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 'sk-canary' } },
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { A: 'b' } },
      },
    });
    const { entries, fileProblems } = read();
    expect(fileProblems).toEqual([]);
    expect(entries.map((e) => [e.key, e.refusal, e.enabledInSource])).toEqual([
      ['claude_json:github', null, true],
      ['claude_json:linear', null, true],
    ]);
    expect(byName(entries, 'github')?.declared).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'gh'],
      cwd: null,
    });
    expect(byName(entries, 'linear')?.declared).toMatchObject({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { A: 'b' },
    });
    expect(byName(entries, 'github')?.configHash).toMatch(/^[0-9a-f]{64}$/);
    const said = text([entries.map((e) => [e.key, e.name, e.refusal, e.configHash]), fileProblems]);
    expect(said).not.toContain('sk-canary');
    expect(said).not.toContain('local');
  });

  it('reads stdio and http servers from config.toml with env_vars, filters and timeouts', () => {
    codexToml(`
model = "x"
[mcp_servers.fs]
command = "npx"
args = ["-y", "fs"]
env = { A = "1" }
env_vars = ["HOME_DIR"]
cwd = "/srv"
enabled_tools = ["read"]
disabled_tools = ["write"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.docs]
url = "https://docs.example/mcp"
bearer_token_env_var = "DOCS_TOKEN"
http_headers = { "X-Team" = "a" }
env_http_headers = { "X-Key" = "DOCS_KEY" }
`);
    const { entries, fileProblems } = read();
    expect(fileProblems).toEqual([]);
    expect(byName(entries, 'fs')).toMatchObject({
      key: 'codex_config:fs',
      refusal: null,
      declared: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'fs'],
        env: { A: '1' },
        envVars: ['HOME_DIR'],
        cwd: '/srv',
        codex: {
          enabledTools: ['read'],
          disabledTools: ['write'],
          startupTimeoutSec: 20,
          toolTimeoutSec: 60,
        },
      },
    });
    expect(byName(entries, 'docs')).toMatchObject({
      refusal: null,
      declared: {
        transport: 'http',
        url: 'https://docs.example/mcp',
        headers: { 'X-Team': 'a' },
        envHeaders: { 'X-Key': 'DOCS_KEY' },
        bearerTokenVar: 'DOCS_TOKEN',
      },
    });
  });

  it('enabled = false in config.toml is enabledInSource false', () => {
    codexToml('[mcp_servers.fs]\ncommand = "npx"\nenabled = false\n');
    expect(read().entries[0]?.enabledInSource).toBe(false);
  });

  it('one bad entry refuses itself and the rest load', () => {
    claudeJson({ mcpServers: { bad: { command: 5 }, good: { command: 'npx' } } });
    const { entries } = read();
    expect(byName(entries, 'bad')).toMatchObject({
      declared: null,
      configHash: null,
      refusal: 'It can’t be read: command',
    });
    expect(byName(entries, 'good')?.refusal).toBeNull();
  });

  it.each([
    [
      'headersHelper',
      { type: 'http', url: 'https://a.example', headersHelper: '/bin/x' },
      'It runs a command for its headers, which 10db doesn’t run yet.',
    ],
    [
      'oauth',
      { type: 'http', url: 'https://a.example', oauth: { clientId: 'x' } },
      'It signs in with OAuth, which 10db doesn’t support yet.',
    ],
    [
      'an unknown type',
      { type: 'ws', url: 'wss://a.example' },
      'Its type isn’t stdio, http or sse.',
    ],
    [
      'a command starting with -',
      { command: '-e' },
      'Its command can’t start with "-". Point it at a script instead.',
    ],
  ])('%s is refused with its reason', (_name, server, reason) => {
    claudeJson({ mcpServers: { s: server } });
    expect(read().entries[0]?.refusal).toBe(reason);
  });

  it('a name with a space is refused with a key, and the rest load', () => {
    claudeJson({ mcpServers: { 'my server': { command: 'npx' }, ok: { command: 'npx' } } });
    const { entries } = read();
    expect(byName(entries, 'my server')).toMatchObject({
      key: 'claude_json:my%20server',
      refusal: 'Its name can’t be an MCP server name.',
    });
    expect(byName(entries, 'ok')?.refusal).toBeNull();
  });

  it('10db-extra, a__b and __proto__ are refused as reserved', () => {
    claudeJson(
      '{"mcpServers": {"10db-extra": {"command": "x"}, "a__b": {"command": "x"}, "__proto__": {"command": "x"}}}',
    );
    const { entries } = read();
    expect(entries.map((e) => [e.name, e.refusal])).toEqual([
      ['10db-extra', 'Its name is kept for 10db’s own server.'],
      ['a__b', 'Its name is kept for 10db’s own server.'],
      ['__proto__', 'Its name is kept for 10db’s own server.'],
    ]);
  });

  it('${TOKEN} in an argument is refused, naming argument 2 and no text', () => {
    claudeJson({ mcpServers: { s: { command: 'npx', args: ['-y', '--key=${TOKEN}sk-canary'] } } });
    const refusal = read().entries[0]?.refusal ?? '';
    expect(refusal).toBe(
      'Its argument 2 uses ${…}, which would put a value on a command line. Set it in its env block instead.',
    );
    expect(refusal).not.toContain('sk-canary');
    expect(refusal).not.toContain('${TOKEN}');
  });

  it('a ~/.claude.json that is not JSON is one problem that quotes nothing', () => {
    claudeJson('{"mcpServers": {"a": {"env": {"T": "sk-canary"');
    const { entries, fileProblems } = read();
    expect(entries).toEqual([]);
    expect(fileProblems).toEqual([
      { what: '~/.claude.json', why: 'It is not valid JSON, so none of its MCP servers load.' },
    ]);
    expect(text(fileProblems)).not.toContain('sk-canary');
    expect(fileProblems[0]?.why).not.toContain('{');
  });

  it('a config.toml that is not TOML is one problem that quotes nothing', () => {
    codexToml('[mcp_servers.a]\nenv = { T = "sk-canary"\n');
    const { fileProblems } = read();
    expect(fileProblems).toEqual([
      {
        what: '~/.codex/config.toml',
        why: 'It is not valid TOML, so none of its MCP servers load.',
      },
    ]);
    expect(text(fileProblems)).not.toContain('sk-canary');
  });

  it('a ~/.claude.json linked to a dotfiles folder loads', () => {
    const dotfiles = join(home, 'dotfiles');
    mkdirSync(dotfiles);
    writeFileSync(
      join(dotfiles, 'claude.json'),
      JSON.stringify({ mcpServers: { a: { command: 'x' } } }),
    );
    symlinkSync(join(dotfiles, 'claude.json'), join(home, '.claude.json'));
    expect(read().entries.map((e) => e.name)).toEqual(['a']);
  });

  it('a ~/.claude.json whose real path is in a checkout is a problem', () => {
    writeFileSync(
      join(checkout, 'claude.json'),
      JSON.stringify({ mcpServers: { a: { command: 'x' } } }),
    );
    symlinkSync(join(checkout, 'claude.json'), join(home, '.claude.json'));
    const { entries, fileProblems } = read();
    expect(entries).toEqual([]);
    expect(fileProblems).toEqual([
      {
        what: '~/.claude.json',
        why: 'It leads into a folder an agent can write, so none of its MCP servers load.',
      },
    ]);
  });

  it('a file over the cap is a problem', () => {
    claudeJson({ mcpServers: {} });
    truncateSync(join(home, '.claude.json'), YOUR_MCP_FILE_MAX_BYTES + 1);
    expect(read().fileProblems).toEqual([
      {
        what: '~/.claude.json',
        why: 'It is larger than 32768 KiB, so none of its MCP servers load.',
      },
    ]);
  });

  it('no files is empty', () => {
    expect(read()).toEqual({ entries: [], fileProblems: [] });
  });
});
