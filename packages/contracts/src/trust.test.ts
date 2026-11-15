import { describe, expect, it } from 'vitest';
import { effectiveTrust, TRUST_DEFAULTS, TrustOverrides, TrustSwitches } from './trust';
import { YourMcpSource, yourMcpServerKey } from './your-mcp';

const a = yourMcpServerKey(YourMcpSource.ClaudeJson, 'a');
const b = yourMcpServerKey(YourMcpSource.ClaudeJson, 'b');
const c = yourMcpServerKey(YourMcpSource.CodexConfig, 'c');

const app: TrustSwitches = {
  ...TRUST_DEFAULTS,
  yourSkills: false,
  plugins: { 'a@m': true, 'b@m': false },
  mcpServers: { [a]: true, [b]: false },
};

describe('effectiveTrust', () => {
  it.each<[string, TrustSwitches, TrustOverrides, TrustSwitches]>([
    ['no overrides is the app’s', app, {}, app],
    ['an override wins one field', app, { web: false }, { ...app, web: false }],
    [
      'plugins merge key by key, the override’s winning',
      app,
      { plugins: { 'b@m': true, 'c@m': false } },
      { ...app, plugins: { 'a@m': true, 'b@m': true, 'c@m': false } },
    ],
    ['an empty plugins override keeps the app’s', app, { plugins: {} }, app],
    [
      'an override without yourMcpServers leaves the app’s off',
      { ...app, yourMcpServers: false },
      TrustOverrides.parse({}),
      { ...app, yourMcpServers: false },
    ],
    [
      'mcpServers merge key by key, the override’s winning',
      app,
      { mcpServers: { [b]: true, [c]: false } },
      { ...app, mcpServers: { [a]: true, [b]: true, [c]: false } },
    ],
  ])('%s', (_name, base, overrides, expected) => {
    expect(effectiveTrust(base, overrides)).toEqual(expected);
  });

  it('a value stored before your MCP servers parses with them on and no per-server switch', () => {
    const stored = {
      web: true,
      projectInstructions: true,
      yourInstructions: true,
      yourSkills: true,
      yourPlugins: true,
      projectSkills: true,
      plugins: {},
    };
    expect(TrustSwitches.parse(stored)).toEqual(TRUST_DEFAULTS);
  });
});
