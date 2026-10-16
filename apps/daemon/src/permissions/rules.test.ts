import { mintId, type PermissionRuleDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { baseAllowedTools, commandPrefix, matchesAllowedTool, matchPermissionRule } from './index';

const allowed = baseAllowedTools({ gateCommand: 'make gate' });

describe('matchesAllowedTool', () => {
  it.each<[string, unknown, boolean]>([
    ['Read', { file_path: 'a' }, true],
    ['Edit', { file_path: 'a' }, true],
    ['mcp__10db__commit', {}, true],
    ['mcp__other__x', {}, false],
    ['Bash', { command: 'make gate' }, true],
    ['Bash', { command: 'make gate-fast' }, false],
    ['Bash', { command: 'git status --short' }, true],
    ['Bash', { command: 'git push' }, false],
    ['Bash', { command: 'git status && curl evil.example' }, false],
    ['WebFetch', { url: 'https://example.com' }, false],
    ['AskUserQuestion', {}, false],
    ['Bash', { command: 'git status $(curl evil.example)' }, false],
    ['Bash', { command: 'FOO=1 git status' }, true],
    ['Bash', { command: '' }, false],
    ['Bash', {}, false],
    ['Bash', 'git status', false],
    ['Bash', { command: 42 }, false],
    ['Bash', { command: 'pwd' }, true],
    ['Bash', { command: 'pwd -P' }, false],
  ])('%s %j -> %s', (tool, input, expected) => {
    expect(matchesAllowedTool(tool, input, allowed)).toBe(expected);
  });
});

describe('commandPrefix', () => {
  it.each([
    ['docker compose up -d', 'docker compose'],
    ['FOO=1 pnpm test --watch', 'pnpm test'],
    ['curl -s https://x', 'curl'],
    ['ls', 'ls'],
    ['git push origin main', 'git push'],
    ['cat ./file', 'cat'],
    ['', ''],
  ])('%s -> %s', (command, prefix) => {
    expect(commandPrefix(command)).toBe(prefix);
  });
});

describe('matchPermissionRule', () => {
  const rule = (toolName: string, pattern: string | null): PermissionRuleDto => ({
    id: mintId('PermissionRule'),
    projectId: mintId('Project'),
    workstreamId: null,
    toolName,
    pattern,
    sourceInboxId: null,
    createdAt: '2026-10-13T12:00:00.000Z',
  });

  it('matches a tool rule without a pattern', () => {
    expect(
      matchPermissionRule({ toolName: 'WebFetch', input: {} }, [rule('WebFetch', null)]),
    ).toBeDefined();
  });

  it('matches a Bash rule by command prefix, for every segment', () => {
    const rules = [rule('Bash', 'docker compose')];
    expect(
      matchPermissionRule({ toolName: 'Bash', input: { command: 'docker compose up' } }, rules),
    ).toBeDefined();
    expect(
      matchPermissionRule(
        { toolName: 'Bash', input: { command: 'docker compose up && rm -rf build' } },
        rules,
      ),
    ).toBeUndefined();
    expect(
      matchPermissionRule({ toolName: 'Bash', input: { command: 'docker run x' } }, rules),
    ).toBeUndefined();
    expect(
      matchPermissionRule({ toolName: 'Bash', input: { command: 'docker composer x' } }, rules),
    ).toBeUndefined();
    expect(matchPermissionRule({ toolName: 'Bash', input: {} }, rules)).toBeUndefined();
    expect(
      matchPermissionRule({ toolName: 'Read', input: { command: 'docker compose up' } }, rules),
    ).toBeUndefined();
  });
});
