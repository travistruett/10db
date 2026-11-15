import {
  TRUST_DEFAULTS,
  YourMcpServerState,
  YourMcpSource,
  yourMcpServerKey,
  type TrustSwitches,
  type YourMcpServerKey,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { DeclaredYourServer, YourMcpEntry } from './your-mcp-config';
import { yourMcpConfigHash } from './your-mcp-hash';
import { planYourMcp, serverState, type YourMcpPlan } from './your-mcp-plan';

const NO_EXTRAS = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
};

function stdio(over: Partial<Extract<DeclaredYourServer, { transport: 'stdio' }>> = {}) {
  return {
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'pkg'],
    env: {},
    envVars: [],
    cwd: null,
    codex: NO_EXTRAS,
    ...over,
  };
}

function remote(over: Partial<Extract<DeclaredYourServer, { transport: 'http' | 'sse' }>> = {}) {
  return {
    transport: 'http' as const,
    url: 'https://mcp.example/mcp',
    headers: {},
    envHeaders: {},
    bearerTokenVar: null,
    codex: NO_EXTRAS,
    ...over,
  };
}

function entry(
  name: string,
  declared: DeclaredYourServer,
  over: Partial<YourMcpEntry> = {},
): YourMcpEntry {
  const source = over.source ?? YourMcpSource.ClaudeJson;
  const pluginId = over.pluginId ?? null;
  return {
    key: yourMcpServerKey(source, name, pluginId ?? undefined),
    name,
    source,
    pluginId,
    declared,
    configHash: yourMcpConfigHash(source, declared),
    enabledInSource: true,
    refusal: null,
    ...over,
  };
}

/** Every entry approved at its current hash. */
const approvedAll = (entries: readonly YourMcpEntry[]): Map<YourMcpServerKey, string> =>
  new Map(entries.flatMap((e) => (e.configHash === null ? [] : [[e.key, e.configHash]])));

const LOGIN = { PATH: '/usr/bin:/bin', HOME: '/Users/b', LANG: 'en_US.UTF-8', SECRET_X: 'login' };

function plan(
  entries: readonly YourMcpEntry[],
  over: {
    switches?: TrustSwitches;
    approvals?: ReadonlyMap<YourMcpServerKey, string>;
    projectServerNames?: readonly string[];
    loginEnv?: Readonly<Record<string, string>>;
    localBinding?: boolean;
  } = {},
): YourMcpPlan {
  return planYourMcp({
    entries,
    switches: over.switches ?? TRUST_DEFAULTS,
    approvals: over.approvals ?? approvedAll(entries),
    projectServerNames: over.projectServerNames ?? [],
    loginEnv: over.loginEnv ?? LOGIN,
    localBinding: over.localBinding ?? false,
  });
}

describe('planYourMcp', () => {
  it('an approved stdio server is planned with the login env and its own, its declared names listed', () => {
    const result = plan([entry('gh', stdio({ env: { TOKEN: 't', PATH: '/opt/bin' } }))]);
    expect(result.leftOut).toEqual([]);
    expect(result.stdio['gh']).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      cwd: null,
      env: { ...LOGIN, TOKEN: 't', PATH: '/opt/bin' },
      declaredEnv: ['PATH', 'TOKEN'],
      codex: NO_EXTRAS,
    });
  });

  it('a Codex-file server gets only the base names, env_vars and its env', () => {
    const result = plan(
      [
        entry('fs', stdio({ env: { A: '1' }, envVars: ['SECRET_X', 'UNSET'], cwd: '/srv' }), {
          source: YourMcpSource.CodexConfig,
        }),
      ],
      { loginEnv: { ...LOGIN, OTHER: 'o' } },
    );
    expect(result.stdio['fs']).toMatchObject({
      cwd: '/srv',
      env: { PATH: LOGIN.PATH, HOME: LOGIN.HOME, LANG: LOGIN.LANG, SECRET_X: 'login', A: '1' },
      declaredEnv: ['A', 'SECRET_X'],
    });
  });

  it('the master switch off plans none and notes none', () => {
    const entries = [entry('a', stdio()), entry('b', stdio(), { refusal: 'Its name …' })];
    expect(plan(entries, { switches: { ...TRUST_DEFAULTS, yourMcpServers: false } })).toEqual({
      stdio: {},
      remote: {},
      leftOut: [],
    });
  });

  it('a server switched off here is not planned and not noted', () => {
    const a = entry('a', stdio());
    expect(plan([a], { switches: { ...TRUST_DEFAULTS, mcpServers: { [a.key]: false } } })).toEqual({
      stdio: {},
      remote: {},
      leftOut: [],
    });
  });

  it('a server off in config.toml stays off unless switched on here', () => {
    const fs = entry('fs', stdio(), { source: YourMcpSource.CodexConfig, enabledInSource: false });
    expect(Object.keys(plan([fs]).stdio)).toEqual([]);
    expect(plan([fs]).leftOut).toEqual([]);
    const on = plan([fs], { switches: { ...TRUST_DEFAULTS, mcpServers: { [fs.key]: true } } });
    expect(Object.keys(on.stdio)).toEqual(['fs']);
  });

  it('a new server waits for approval, named', () => {
    const result = plan([entry('a', stdio())], { approvals: new Map() });
    expect(result.stdio).toEqual({});
    expect(result.leftOut).toEqual([
      {
        what: 'your MCP server a (~/.claude.json)',
        why: 'waiting for your approval in Settings › Trust',
      },
    ]);
  });

  it('a changed server is off until approved again, named', () => {
    const a = entry('a', stdio());
    const result = plan([a], { approvals: new Map([[a.key, 'f'.repeat(64)]]) });
    expect(result.stdio).toEqual({});
    expect(result.leftOut).toEqual([
      {
        what: 'your MCP server a (~/.claude.json)',
        why: 'changed since you approved it; approve it again in Settings › Trust',
      },
    ]);
  });

  it('a plugin server needs no approval', () => {
    const p = entry('browser', stdio(), { source: YourMcpSource.Plugin, pluginId: 'tools@m' });
    const result = plan([p], { approvals: new Map() });
    expect(Object.keys(result.stdio)).toEqual(['browser']);
    expect(serverState(p, new Map())).toBe(YourMcpServerState.Approved);
  });

  it('a plugin server follows its own switch, off here and named nowhere', () => {
    const p = entry('browser', stdio(), { source: YourMcpSource.Plugin, pluginId: 'tools@m' });
    const off = plan([p], { switches: { ...TRUST_DEFAULTS, mcpServers: { [p.key]: false } } });
    expect(off).toEqual({ stdio: {}, remote: {}, leftOut: [] });
  });

  it('serverState names each state', () => {
    const a = entry('a', stdio());
    expect(serverState(a, new Map())).toBe(YourMcpServerState.New);
    expect(serverState(a, new Map([[a.key, 'f'.repeat(64)]]))).toBe(YourMcpServerState.Changed);
    expect(serverState(a, approvedAll([a]))).toBe(YourMcpServerState.Approved);
    expect(serverState({ ...a, refusal: 'no' }, approvedAll([a]))).toBe(YourMcpServerState.LeftOut);
  });

  it('a project server’s name wins, and yours is named', () => {
    const result = plan([entry('gh', stdio())], { projectServerNames: ['gh'] });
    expect(result.stdio).toEqual({});
    expect(result.leftOut).toEqual([
      {
        what: 'your MCP server gh (~/.claude.json)',
        why: "the project's .mcp.json declares a server with this name",
      },
    ]);
  });

  it('~/.claude.json wins a name over config.toml', () => {
    const codex = entry('gh', stdio({ command: 'codex-gh' }), {
      source: YourMcpSource.CodexConfig,
    });
    const claude = entry('gh', stdio({ command: 'claude-gh' }));
    const result = plan([codex, claude]);
    expect(result.stdio['gh']?.command).toBe('claude-gh');
    expect(result.leftOut).toEqual([
      {
        what: 'your MCP server gh (~/.codex/config.toml)',
        why: 'a server named gh is already in this session from ~/.claude.json',
      },
    ]);
  });

  it('${TOKEN} expands from the login env into env, the url and a header', () => {
    const loginEnv = { ...LOGIN, TOKEN: 'sk-1', HOST: 'mcp.example' };
    const result = plan(
      [
        entry('s', stdio({ env: { KEY: 'k-${TOKEN}', D: '${UNSET:-dflt}' } })),
        entry(
          'r',
          remote({ url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }),
        ),
      ],
      { loginEnv },
    );
    expect(result.stdio['s']?.env).toMatchObject({ KEY: 'k-sk-1', D: 'dflt' });
    expect(result.remote['r']).toEqual({
      type: 'http',
      url: 'https://mcp.example/mcp',
      headers: { Authorization: 'Bearer sk-1' },
      codex: NO_EXTRAS,
    });
  });

  it('${MISSING} without a default is left out, naming MISSING and no value', () => {
    const result = plan([entry('s', stdio({ env: { KEY: 'sk-canary-${MISSING}' } }))]);
    expect(result.stdio).toEqual({});
    expect(result.leftOut).toEqual([
      {
        what: 'your MCP server s (~/.claude.json)',
        why: 'its env KEY uses ${MISSING}, which is not set in your login environment',
      },
    ]);
  });

  it('bearer_token_env_var becomes an Authorization header', () => {
    const docs = entry(
      'docs',
      remote({
        bearerTokenVar: 'DOCS_TOKEN',
        envHeaders: { 'X-Key': 'DOCS_KEY', 'X-No': 'UNSET' },
      }),
      { source: YourMcpSource.CodexConfig },
    );
    const result = plan([docs], { loginEnv: { ...LOGIN, DOCS_TOKEN: 'tok', DOCS_KEY: 'key' } });
    expect(result.remote['docs']?.headers).toEqual({ Authorization: 'Bearer tok', 'X-Key': 'key' });
    const unset = plan([docs]);
    expect(unset.remote).toEqual({});
    expect(unset.leftOut[0]?.why).toBe(
      'its bearer_token_env_var names DOCS_TOKEN, which is not set in your login environment',
    );
  });

  it.each([
    ['http://localhost:3000/mcp'],
    ['http://api.localhost/mcp'],
    ['http://127.0.0.2/mcp'],
    ['http://[::1]:8080/mcp'],
    ['http://0.0.0.0/mcp'],
    ['http://localhost.:3000/mcp'],
  ])(
    'a loopback server %s with headers is left out while the project’s loopback is on, and kept while it is off',
    (url) => {
      const local = [entry('local', remote({ url, headers: { A: 'b' } }))];
      const on = plan(local, { localBinding: true });
      expect(on.remote).toEqual({});
      expect(on.leftOut[0]?.why).toBe(
        "it sends its headers to this Mac, where this project's commands may listen; turn the project's loopback off to use it",
      );
      expect(Object.keys(plan(local, { localBinding: false }).remote)).toEqual(['local']);
    },
  );

  it.each([
    ['a query', 'http://localhost:3000/mcp?key=abc'],
    ['userinfo', 'http://user:pw@localhost:3000/mcp'],
    ['a ${} reference in the path', 'http://localhost:3000/${TOKEN}/mcp'],
    ['a ${} reference in the query', 'http://127.0.0.1:3000/mcp?k=${TOKEN}'],
    ['a fragment', 'http://localhost:3000/mcp#abc'],
    ['a long token in a path segment', 'http://127.0.0.1:3000/t/9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c'],
    ['a segment of letters and digits 12 or longer', 'http://localhost:3000/mcp/abc123def456'],
    ['an encoded path segment', 'http://localhost:3000/a%2Fb'],
    ['more than four path segments', 'http://localhost:3000/a/b/c/d/e'],
  ])('a loopback server whose url carries %s counts as one with headers', (_name, url) => {
    const local = [entry('local', remote({ url }))];
    const loginEnv = { ...LOGIN, TOKEN: 'sk-1' };
    const on = plan(local, { localBinding: true, loginEnv });
    expect(on.remote).toEqual({});
    expect(on.leftOut[0]?.why).toBe(
      "it sends its headers to this Mac, where this project's commands may listen; turn the project's loopback off to use it",
    );
    expect(Object.keys(plan(local, { localBinding: false, loginEnv }).remote)).toEqual(['local']);
  });

  it.each([
    ['http://localhost:3000/mcp'],
    ['http://localhost:3000/sse'],
    ['http://[::1]/v1/mcp/'],
    ['http://localhost:3000/api/mcp'],
  ])('an ordinary loopback path %s with no headers is kept while the loopback is on', (url) => {
    const local = [entry('local', remote({ url }))];
    expect(Object.keys(plan(local, { localBinding: true }).remote)).toEqual(['local']);
  });

  it('a remote server on another host keeps its query and userinfo while the loopback is on', () => {
    const far = [entry('far', remote({ url: 'https://user:pw@mcp.example/mcp?key=abc' }))];
    expect(Object.keys(plan(far, { localBinding: true }).remote)).toEqual(['far']);
  });

  it('a localhost server with no headers is kept either way', () => {
    const local = [entry('local', remote({ url: 'http://localhost:3000/mcp' }))];
    expect(plan(local, { localBinding: true }).remote['local']?.headers).toBeNull();
    expect(Object.keys(plan(local, { localBinding: false }).remote)).toEqual(['local']);
  });

  it('no left-out reason holds any env, header, argument or URL text', () => {
    const canary = 'sk-canary';
    const declared = stdio({ args: [canary], env: { TOKEN: canary } });
    const fresh = entry('fresh', declared);
    const all = [
      entry('refused', declared, { refusal: 'Its argument 1 uses ${…}.' }),
      fresh,
      entry('missing', stdio({ args: [canary], env: { KEY: `${canary}\${MISSING}` } })),
      entry('local', remote({ url: `http://localhost/${canary}`, headers: { A: canary } })),
      entry('dup', declared, { source: YourMcpSource.CodexConfig }),
      entry('dup', declared),
    ];
    const approvals = approvedAll(all);
    approvals.delete(fresh.key);
    const result = plan(all, { approvals, localBinding: true });
    expect(result.leftOut.map((l) => l.what)).toEqual([
      'your MCP server refused (~/.claude.json)',
      'your MCP server fresh (~/.claude.json)',
      'your MCP server missing (~/.claude.json)',
      'your MCP server local (~/.claude.json)',
      'your MCP server dup (~/.codex/config.toml)',
    ]);
    expect(JSON.stringify(result.leftOut)).not.toContain(canary);
  });
});
