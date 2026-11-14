import { describe, expect, it } from 'vitest';
import { YourMcpServerKey, YourMcpSource, yourMcpServerKey } from './your-mcp';

describe('yourMcpServerKey', () => {
  it.each<[string, YourMcpSource, string, string | undefined, string]>([
    [
      'a ~/.claude.json server',
      YourMcpSource.ClaudeJson,
      'github',
      undefined,
      'claude_json:github',
    ],
    ['a config.toml server', YourMcpSource.CodexConfig, 'linear', undefined, 'codex_config:linear'],
    [
      'a plugin server',
      YourMcpSource.Plugin,
      'browser',
      'tools@market',
      'plugin:tools%40market:browser',
    ],
  ])('%s', (_name, source, name, pluginId, expected) => {
    expect(yourMcpServerKey(source, name, pluginId)).toBe(expected);
  });

  it('a name with a space or a colon makes a key the schema takes', () => {
    const key = yourMcpServerKey(YourMcpSource.ClaudeJson, 'my server:2');
    expect(key).toBe('claude_json:my%20server%3A2');
    expect(YourMcpServerKey.safeParse(key).success).toBe(true);
  });

  it('the key schema refuses a key with no source', () => {
    expect(YourMcpServerKey.safeParse('github').success).toBe(false);
    expect(YourMcpServerKey.safeParse('other:github').success).toBe(false);
    expect(YourMcpServerKey.safeParse('__proto__').success).toBe(false);
  });
});
