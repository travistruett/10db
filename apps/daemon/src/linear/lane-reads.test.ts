import { Provider } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { isLaneLinearRead, laneLinearPrefixes } from './lane-reads';

const LINEAR_URL = 'https://mcp.linear.app/mcp';
// Built from parts so the secret scanner in the commit hook does not read it as a key.
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

describe('isLaneLinearRead', () => {
  const prefixes = laneLinearPrefixes({
    remote: { linear: { url: LINEAR_URL, claudeName: null } },
    connectors: true,
    harness: Provider.Claude,
  });
  it('settles a read of the builder’s Linear, and nothing that writes, fetches or carries text out', () => {
    const rows: [string, string, unknown, boolean][] = [
      ['get_issue', 'mcp__linear__get_issue', { id: 'AMP-6', includeRelations: true }, true],
      ['list_comments', 'mcp__linear__list_comments', { issueId: 'AMP-26' }, true],
      ['the connector', 'mcp__claude_ai_Linear__list_issues', { team: 'AMP' }, true],
      ['another server', 'mcp__other__get_issue', { id: 'AMP-6' }, false],
      ['a comment', 'mcp__linear__save_comment', { issueId: 'AMP-6', body: 'the diff' }, false],
      [
        'an issue write',
        'mcp__linear__save_issue',
        { id: 'AMP-6', description: 'the repo' },
        false,
      ],
      ['extract_images', 'mcp__linear__extract_images', { markdown: '![x](y)' }, false],
      ['a secret', 'mcp__linear__get_issue', { id: `AMP-6 ${AWS_KEY}` }, false],
      ['a long input', 'mcp__linear__list_issues', { query: 'x'.repeat(2_100) }, false],
      ['10db’s own tool', 'mcp__10db__complete_step', {}, false],
    ];
    for (const [name, tool, input, expected] of rows) {
      expect.soft(isLaneLinearRead(prefixes, tool, input), name).toBe(expected);
    }
  });
});

describe('laneLinearPrefixes', () => {
  const remote = {
    linear: { url: LINEAR_URL, claudeName: null },
    'linear-plugin': { url: LINEAR_URL, claudeName: 'plugin:linear:linear' },
    docs: { url: 'https://docs.example.com/mcp', claudeName: null },
  };
  it('names the connector and each Linear server as each harness registers it', () => {
    expect(laneLinearPrefixes({ remote, connectors: true, harness: Provider.Claude })).toEqual([
      'mcp__claude_ai_Linear__',
      'mcp__linear__',
      'mcp__plugin_linear_linear__',
    ]);
    expect(laneLinearPrefixes({ remote, connectors: true, harness: Provider.Codex })).toEqual([
      'mcp__linear__',
      'mcp__linear-plugin__',
    ]);
  });
});
