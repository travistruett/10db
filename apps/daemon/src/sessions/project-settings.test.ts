import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fullAccessSettingsBillingProblem,
  projectSettingsBillingProblem,
} from './project-settings';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo and a config folder holding the named settings files. */
function folders(files: { local?: object; project?: object; user?: object }) {
  const repo = mkdtempSync(join(tmpdir(), 'settings-repo-'));
  const config = mkdtempSync(join(tmpdir(), 'settings-config-'));
  made.push(repo, config);
  mkdirSync(join(repo, '.claude'));
  if (files.project)
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(files.project));
  if (files.local)
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify(files.local));
  if (files.user) writeFileSync(join(config, 'settings.json'), JSON.stringify(files.user));
  return { repo, config };
}

describe('the settings a session loads cannot move billing', () => {
  it('refuses the local and user files by name, and lets a provider switch set off through', () => {
    const local = folders({ local: { env: { AWS_PROFILE: 'other' } } });
    expect(fullAccessSettingsBillingProblem(local.repo, local.config)).toContain(
      'settings.local.json sets AWS_PROFILE',
    );
    // A lane loads only the project's file.
    expect(projectSettingsBillingProblem(local.repo)).toBeNull();
    const user = folders({ user: { apiKeyHelper: 'echo key' } });
    expect(fullAccessSettingsBillingProblem(user.repo, user.config)).toContain('apiKeyHelper');
    const off = folders({
      local: { env: { CLAUDE_CODE_USE_BEDROCK: 'false', CLAUDE_CODE_USE_VERTEX: '0' } },
    });
    expect(fullAccessSettingsBillingProblem(off.repo, off.config)).toBeNull();
    const on = folders({ local: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } });
    expect(fullAccessSettingsBillingProblem(on.repo, on.config)).toContain(
      'CLAUDE_CODE_USE_BEDROCK',
    );
  });
});
