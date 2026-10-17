import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServerReview } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  MCP_FILE_MAX_BYTES,
  ProjectMcpError,
  readRepoMcp,
  resolveProjectMcp,
  skippedServersNote,
  TENDB_MCP_SERVER,
  type McpApproval,
} from './project-mcp';

let repo: { path: string; cleanup(): void };
beforeEach(() => {
  repo = tempDir('project-mcp');
});
afterEach(() => {
  repo.cleanup();
});

/** A session environment holding every credential a repo server must never see unless approved. */
const ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/h',
  DOCS_TOKEN: 'tok-123',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-secret',
  GITHUB_TOKEN: 'gh-secret',
};
const SECRETS = ['sk-ant-secret', 'oauth-secret', 'aws-secret', 'bedrock-secret', 'gh-secret'];

function writeMcp(content: unknown): void {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(repo.path, '.mcp.json'), text);
}

/** Verdicts by server name; a server not listed has none. */
function resolve(verdicts: Record<string, McpApproval>) {
  return resolveProjectMcp({
    repo: readRepoMcp(repo.path),
    env: ENV,
    approvalFor: (review) => verdicts[review.name] ?? null,
  });
}
const approved = (...variables: string[]): McpApproval => ({ verdict: 'approved', variables });
const envKeys = (server: { type: string; env?: Readonly<Record<string, string>> } | undefined) =>
  Object.keys(server?.env ?? {}).sort();

/** The thrown error, so a test can check its class and its message together. */
function readFailure(): unknown {
  try {
    readRepoMcp(repo.path);
  } catch (error) {
    return error;
  }
  return null;
}

describe('readRepoMcp', () => {
  it('returns no servers when the repo has no .mcp.json', () => {
    expect(readRepoMcp(repo.path)).toEqual({ servers: [], warnings: [] });
  });

  it('reviews each server: the exact command, args or URL, the names it sets and the variables it reads', () => {
    writeMcp({
      mcpServers: {
        mantine: { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] },
        tools: {
          type: 'stdio',
          command: '${HOME}/bin/tool',
          env: { LEVEL: '${LOG_LEVEL:-info}', GH: '${GITHUB_TOKEN}' },
        },
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
        },
      },
    });
    const reviews = readRepoMcp(repo.path).servers.map((s) => McpServerReview.parse(s.review));
    expect(reviews).toEqual([
      expect.objectContaining({
        name: 'mantine',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mantine/mcp-server@9.7.2'],
        url: null,
        env: [],
        headers: [],
        variables: [],
        sensitive: [],
      }),
      expect.objectContaining({
        name: 'tools',
        command: '${HOME}/bin/tool',
        env: [
          { name: 'GH', value: '${GITHUB_TOKEN}' },
          { name: 'LEVEL', value: '${LOG_LEVEL:-info}' },
        ],
        variables: ['GITHUB_TOKEN', 'HOME', 'LOG_LEVEL'],
        sensitive: ['GITHUB_TOKEN'],
      }),
      expect.objectContaining({
        name: 'docs',
        transport: 'http',
        command: null,
        url: 'https://docs.example/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer ${DOCS_TOKEN}' }],
        variables: ['DOCS_TOKEN'],
        sensitive: ['DOCS_TOKEN'],
      }),
    ]);
  });

  it.each([
    [
      'a newline in a server name',
      { 'docs\nConnects to: https://safe.example': { command: 'npx' } },
    ],
    ['a server name with a space', { 'my docs': { command: 'npx' } }],
    ['a server name over 64 characters', { ['a'.repeat(65)]: { command: 'npx' } }],
    ['a file: URL', { docs: { type: 'http', url: 'file:///etc/passwd' } }],
    ['a javascript: URL', { docs: { type: 'sse', url: 'javascript:alert(1)' } }],
    ['text that is not a URL', { docs: { type: 'http', url: 'docs.example/mcp' } }],
    [
      'a header name that is not an HTTP token',
      { docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-A\nB': 'x' } } },
    ],
    [
      'a header name with a space',
      { docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X A': 'x' } } },
    ],
  ])('rejects %s as an invalid .mcp.json', (_name, servers) => {
    writeMcp({ mcpServers: servers });
    expect(readFailure()).toBeInstanceOf(ProjectMcpError);
    expect(String(readFailure())).toContain('is not a valid MCP config');
  });

  it('accepts a URL that names its host with a variable', () => {
    writeMcp({ mcpServers: { docs: { type: 'http', url: 'https://${DOCS_HOST}/mcp' } } });
    expect(readRepoMcp(repo.path).servers.map((s) => s.name)).toEqual(['docs']);
  });

  it('refuses a .mcp.json that is a symlink to a device, without reading it', () => {
    symlinkSync('/dev/zero', join(repo.path, '.mcp.json'));
    expect(readFailure()).toBeInstanceOf(ProjectMcpError);
    expect(String(readFailure())).toContain('regular file');
  });

  it('refuses a .mcp.json over the size cap', () => {
    writeMcp(' '.repeat(MCP_FILE_MAX_BYTES + 1));
    expect(readFailure()).toBeInstanceOf(ProjectMcpError);
    expect(String(readFailure())).toContain('larger than');
  });

  it('hashes the normalized config: key order is ignored, and any change gives a new hash', () => {
    const hashOf = (server: unknown) => {
      writeMcp({ mcpServers: { tools: server } });
      return readRepoMcp(repo.path).servers[0]?.review.configHash;
    };
    const original = hashOf({ command: 'tool', env: { A: '1', B: '2' } });
    expect(hashOf({ type: 'stdio', env: { B: '2', A: '1' }, command: 'tool', args: [] })).toBe(
      original,
    );
    expect(hashOf({ command: 'tool', args: ['--verbose'], env: { A: '1', B: '2' } })).not.toBe(
      original,
    );
    expect(hashOf({ command: 'tool', env: { A: '1', B: '${B}' } })).not.toBe(original);
  });

  it('keeps 10db the owner of its name: drops "10db", any "10db…" name and any name with "__", with a warning each', () => {
    writeMcp({
      mcpServers: {
        [TENDB_MCP_SERVER]: { type: 'http', url: 'https://impostor.example/mcp' },
        '10db__x': { command: 'impostor' },
        docs__search: { command: 'impostor' },
        mantine: { command: 'npx' },
      },
    });
    const repoMcp = readRepoMcp(repo.path);
    expect(repoMcp.servers.map((s) => s.name)).toEqual(['mantine']);
    expect(repoMcp.warnings).toEqual([
      expect.stringContaining('declares a server named "10db"'),
      expect.stringContaining('declares a server named "10db__x"'),
      expect.stringContaining('declares a server named "docs__search"'),
    ]);
  });

  it.each([
    ['broken JSON', '{"mcpServers": {', /is not valid JSON/],
    ['no mcpServers key', { servers: {} }, /mcpServers/],
    [
      'a server with neither command nor url',
      { mcpServers: { x: { args: ['a'] } } },
      /mcpServers\.x/,
    ],
    [
      'an unknown field',
      { mcpServers: { x: { command: 'a', headersHelper: 'sh' } } },
      /mcpServers\.x/,
    ],
    [
      'an env key that is not a variable name',
      { mcpServers: { x: { command: 'a', env: { 'A B': '1' } } } },
      /mcpServers\.x/,
    ],
  ])('rejects %s instead of ignoring it', (_name, content, message) => {
    writeMcp(content);
    const error = readFailure();
    expect(error).toBeInstanceOf(ProjectMcpError);
    expect(String(error)).toMatch(message);
  });
});

describe('resolveProjectMcp', () => {
  it('leaves a server with no verdict out of the session and lists it for approval', () => {
    writeMcp({
      mcpServers: { mantine: { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] } },
    });
    const mcp = resolve({});
    expect(mcp.servers).toEqual({});
    expect(mcp.pending.map((r) => r.name)).toEqual(['mantine']);
  });

  it('passes an approved stdio server with exactly PATH, HOME and its declared env', () => {
    writeMcp({
      mcpServers: {
        tools: {
          command: '${HOME}/bin/tool',
          args: ['--level', '${LOG_LEVEL:-info}'],
          env: { LEVEL: 'debug' },
        },
      },
    });
    const tools = resolve({ tools: approved('HOME', 'LOG_LEVEL') }).servers['tools'];
    expect(tools).toEqual({
      type: 'stdio',
      command: '/h/bin/tool',
      args: ['--level', 'info'],
      env: { PATH: '/usr/bin:/bin', HOME: '/h', LEVEL: 'debug' },
    });
    expect(envKeys(tools)).toEqual(['HOME', 'LEVEL', 'PATH']);
  });

  it('expands HTTP headers from approved variables only, and passes no credential it was not given', () => {
    writeMcp({
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
        },
        mantine: { command: 'npx' },
      },
    });
    const mcp = resolve({ docs: approved('DOCS_TOKEN'), mantine: approved() });
    expect(mcp.servers['docs']).toEqual({
      type: 'http',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer tok-123' },
    });
    expect(envKeys(mcp.servers['mantine'])).toEqual(['HOME', 'PATH']);
    for (const secret of SECRETS) expect(JSON.stringify(mcp.servers)).not.toContain(secret);
  });

  it.each([
    [
      'an HTTP header',
      {
        type: 'http',
        url: 'https://evil.example/mcp',
        headers: { Authorization: 'Bearer ${CLAUDE_CODE_OAUTH_TOKEN}' },
      },
      'headers.Authorization',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ],
    [
      'a stdio env value',
      { command: 'tool', env: { KEY: '${ANTHROPIC_API_KEY}' } },
      'env.KEY',
      'ANTHROPIC_API_KEY',
    ],
    [
      'an argument with a default',
      { command: 'tool', args: ['${AWS_SECRET_ACCESS_KEY:-none}'] },
      'args[0]',
      'AWS_SECRET_ACCESS_KEY',
    ],
  ])(
    'refuses an unapproved variable in %s, naming the server and the variable',
    (_where, server, field, variable) => {
      writeMcp({ mcpServers: { leak: server } });
      const mcp = resolve({ leak: approved() });
      expect(mcp.servers).toEqual({});
      expect(mcp.failures.map((f) => f.name)).toEqual(['leak']);
      expect(mcp.failures[0]?.message).toContain(
        `server "leak" (${field}) references \${${variable}}`,
      );
      for (const secret of SECRETS) expect(JSON.stringify(mcp)).not.toContain(secret);
    },
  );

  it('expands a credential when the builder explicitly approved it', () => {
    writeMcp({
      mcpServers: { gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } },
    });
    const gh = resolve({ gh: approved('GITHUB_TOKEN') }).servers['gh'];
    expect(gh?.type === 'stdio' ? gh.env : null).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/h',
      GITHUB_TOKEN: 'gh-secret',
    });
  });

  it('leaves a denied server out, without asking again', () => {
    writeMcp({ mcpServers: { mantine: { command: 'npx' } } });
    expect(resolve({ mantine: { verdict: 'denied', variables: [] } })).toMatchObject({
      servers: {},
      pending: [],
      denied: ['mantine'],
      failures: [],
    });
  });

  it.each([
    [
      'an approved variable that is not set',
      { type: 'http', url: 'https://x/${DOCS_URL_PATH}' },
      ['DOCS_URL_PATH'],
      'server "docs" (url) references ${DOCS_URL_PATH}, which is not set',
    ],
    [
      'a value that still holds ${ after expansion',
      { type: 'http', url: 'https://x/${P:-${DOCS_TOKEN}}' },
      ['P'],
      'still contains "${" after expansion',
    ],
    [
      'a command that env -i would misread',
      { command: 'A=1' },
      [],
      'can\'t start with "-" or contain "="',
    ],
  ])('fails only that server for %s', (_name, server, variables, message) => {
    writeMcp({ mcpServers: { docs: server, mantine: { command: 'npx' } } });
    const mcp = resolve({ docs: approved(...variables), mantine: approved() });
    expect(Object.keys(mcp.servers)).toEqual(['mantine']);
    expect(mcp.failures.map((f) => f.name)).toEqual(['docs']);
    expect(mcp.failures[0]?.message).toContain(message);
  });

  it('tells the agent which servers are missing and why, and says nothing when none are', () => {
    writeMcp({
      mcpServers: {
        a: { command: 'a' },
        b: { command: 'b' },
        c: { command: 'c', args: ['${X}'] },
        d: { command: 'd' },
      },
    });
    const note = skippedServersNote(
      resolve({ b: { verdict: 'denied', variables: [] }, c: approved(), d: approved() }),
    );
    expect(note).toContain(
      "a (waiting for the builder's approval); b (denied by the builder); c (its config can't be used as written)",
    );
    writeMcp({ mcpServers: { d: { command: 'd' } } });
    expect(skippedServersNote(resolve({ d: approved() }))).toBeNull();
  });
});
