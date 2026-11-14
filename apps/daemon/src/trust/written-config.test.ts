import { describe, expect, it } from 'vitest';
import { writtenConfig } from './written-config';

// T4 call 22: the config a run wrote, which runs only after the builder approves it, is listed.
describe('writtenConfig', () => {
  it.each([
    ['.mcp.json', true],
    ['.claude/hooks/x.sh', true],
    ['.claude/settings.local.json', true],
    ['.claude/skills/x/SKILL.md', true],
    ['.vscode/tasks.json', true],
    ['.idea/workspace.xml', true],
    ['.config/mise/config.toml', true],
    ['mise.toml', true],
    ['packages/a/mise.local.toml', true],
    ['.tool-versions', true],
    ['.MCP.json', true],
    ['.Claude/Hooks/x.sh', true],
    ['src/a.ts', false],
    ['docs/.claude-notes.md', false],
    ['src/.mcp.json.bak', false],
  ])('%s is config: %s', (path, listed) => {
    expect(writtenConfig([path])).toEqual(listed ? [path] : []);
  });
});
