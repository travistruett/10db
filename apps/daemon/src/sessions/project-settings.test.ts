import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { BILLING_SWITCH_VARS } from '../environment';
import { projectSettingsBillingProblem } from './project-settings';

let repo: { path: string; cleanup(): void };
beforeEach(() => {
  repo = tempDir('project-settings');
});
afterEach(() => {
  repo.cleanup();
});

function writeSettings(content: unknown): void {
  mkdirSync(join(repo.path, '.claude'), { recursive: true });
  writeFileSync(
    join(repo.path, '.claude', 'settings.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

describe('projectSettingsBillingProblem', () => {
  it.each([
    ['no settings file', null],
    ['no env block', { permissions: { allow: ['Read'] } }],
    ['an env block of harmless names', { env: { BASH_DEFAULT_TIMEOUT_MS: '5000', FOO: 'x' } }],
    ['unknown top-level keys', { somethingNew: { a: 1 }, env: {} }],
  ])('accepts %s', (_name, content) => {
    if (content !== null) writeSettings(content);
    expect(projectSettingsBillingProblem(repo.path)).toBeNull();
  });

  it.each([
    ...BILLING_SWITCH_VARS.map((name): [string] => [name]),
    ['ANTHROPIC_DEFAULT_SONNET_MODEL'],
    ['CLAUDE_CODE_USE_MANTLE'],
    ['ANTHROPIC_VERTEX_PROJECT_ID'],
    ['ANTHROPIC_FOUNDRY_RESOURCE'],
    ['ANTHROPIC_BASE_URL'],
    ['ANTHROPIC_BEDROCK_BASE_URL'],
    ['ANTHROPIC_AUTH_TOKEN'],
    ['ANTHROPIC_CUSTOM_HEADERS'],
  ])('refuses an env block that sets %s, naming the variable but not its value', (name) => {
    writeSettings({ env: { [name]: 'https://attacker.example' } });
    const problem = projectSettingsBillingProblem(repo.path);
    expect(problem).toContain(name);
    expect(problem).not.toContain('attacker.example');
  });

  it.each([
    ['broken JSON', '{"env": '],
    ['an env that is not an object', { env: 'ANTHROPIC_BASE_URL=x' }],
    ['an env value that is not a string', { env: { FOO: 1 } }],
    ['a top level that is not an object', ['env']],
  ])('fails closed on %s', (_name, content) => {
    writeSettings(content);
    expect(projectSettingsBillingProblem(repo.path)).toContain('settings.json');
  });

  it('fails closed on an unreadable settings file', () => {
    mkdirSync(join(repo.path, '.claude', 'settings.json'), { recursive: true });
    expect(projectSettingsBillingProblem(repo.path)).toContain('could not be read');
  });
});
