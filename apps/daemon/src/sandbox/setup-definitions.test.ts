import { describe, expect, it } from 'vitest';
import { withoutStrippedKeys } from './setup-definitions';

describe('withoutStrippedKeys', () => {
  it.each<[string, string, ReturnType<typeof withoutStrippedKeys>]>([
    ['a file with none is left as it is', '---\nname: s\ndescription: mcp in\n---\nBody\n', null],
    [
      'hooks and allowed-tools stay, as Claude Code reads them',
      '---\nname: s\nhooks: {}\nallowed-tools: Bash\n---\nBody\n',
      null,
    ],
    [
      'mcpServers goes, every other key and the body stay',
      '---\nname: s\nmcpServers: {}\nallowed-tools: Bash\nmodel: opus\n---\nBody !`ls`\n',
      {
        text: '---\nname: s\nallowed-tools: Bash\nmodel: opus\n---\nBody !`ls`\n',
        notes: ['MCP servers arrive with Your MCP servers (T6)'],
      },
    ],
    [
      'a second block the body opens, read once the first is gone',
      '---\nmcpServers: {}\n---\n---\nmcpServers:\n  s: {}\n---\nBody\n',
      { refused: 'what Claude Code would read of it still holds MCP servers' },
    ],
    [
      'a merge key that could bring in MCP servers, which another YAML reader may follow',
      '---\nname: s\n<<: {mcpServers: {}}\n---\nBody\n',
      { refused: "its frontmatter merges in keys 10db can't see" },
    ],
    ['a merge key that could bring in none', '---\nname: s\n<<: {model: opus}\n---\nBody\n', null],
    [
      'unreadable frontmatter whose text could name a stripped key',
      '---\nname: s\n"\\x6dcpServers": [\n---\nBody\n',
      { refused: 'its frontmatter is not YAML 10db reads, and it may hold MCP servers' },
    ],
    ['unreadable frontmatter that could name none', '---\nname: [s\n---\nBody\n', null],
  ])('%s', (_name, text, expected) => {
    expect(withoutStrippedKeys(text)).toEqual(expected);
  });
});
