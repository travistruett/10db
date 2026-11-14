import { describe, expect, it } from 'vitest';
import { writtenConfig } from './written-config';

// The config a run wrote, which runs only after the builder approves it, is listed, mise's at any depth.
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
    ['.mise/config.toml', true],
    ['packages/a/.mise/config.local.toml', true],
    ['mise/config.local.toml', true],
    ['packages/a/mise/config.toml', true],
    ['.config/mise.toml', true],
    ['packages/a/.config/mise.local.toml', true],
    ['packages/a/.config/mise/conf.d/x.toml', true],
    ['packages/a/.mise.local.toml', true],
    ['docs/mise-notes.md', false],
    ['src/promise.toml', false],
    ['.MCP.json', true],
    ['.Claude/Hooks/x.sh', true],
    ['src/a.ts', false],
    ['docs/.claude-notes.md', false],
    ['src/.mcp.json.bak', false],
  ])('%s is config: %s', (path, listed) => {
    expect(writtenConfig([path])).toEqual(listed ? [path] : []);
  });
});
