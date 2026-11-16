import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AccountKind, type ProjectDto } from '@10db/contracts';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import { createCodexAdapter } from '../sessions';
import { prepareTakeover, type TakeoverSource } from './prepare';

// Sessions spec §7.5, the Codex provider: a terminal's set holds a sealed header file at mode 600, the instructions
// as a TOML string, and never a plugin directory, since Codex has no flag for them.

let dir: TempDir | null = null;
afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const SOURCE: TakeoverSource = {
  cwd: '/repo',
  kind: AccountKind.CodexSignin,
  model: 'gpt-5.5',
  effort: 'high',
  launch: {
    set: {},
    unset: [],
    unsetPrefixes: ['TENDB_'],
    keychain: [],
    apiKeyHelperAccount: null,
    scrub: false,
    model: 'gpt-5.5',
  },
  web: false,
};

describe('prepareTakeover for a Codex chat', () => {
  it('seals header values at mode 600, writes the instructions as TOML and passes no plugin folder', async () => {
    dir = tempDir('prepare-codex');
    const made = createTestStore();
    const project: ProjectDto = seedProject(made.store, { name: 'alpha' });
    const adapter = createCodexAdapter({ codexPath: '/usr/local/bin/codex', logger: silentLogger });
    const set = await prepareTakeover(
      {
        adapter,
        servers: () =>
          Promise.resolve({
            instructions: 'Say "hi"\nthen stop.',
            pluginDirs: ['/plugins/one'],
            projectMcpServers: {},
            yourMcpServers: {
              docs: {
                connect: {
                  type: 'http',
                  url: 'https://docs.example/mcp',
                  headers: { Authorization: 'Bearer sk-canary' },
                },
                claudeOAuth: null,
                codex: {
                  enabledTools: null,
                  disabledTools: [],
                  startupTimeoutSec: null,
                  toolTimeoutSec: null,
                },
              },
            },
            notes: [],
            tempDirs: [],
            remove: () => undefined,
          }),
        onboard: () => Promise.resolve(),
        newSetId: () => 'ab12',
      },
      { project, source: SOURCE, providerSessionId: 'thread-1', folder: dir.path },
      new AbortController().signal,
    );
    made.close();
    const files = readdirSync(dir.path);
    const sealed = files.find((f) => f.startsWith('sealed-'));
    expect(sealed).toBeDefined();
    expect(statSync(join(dir.path, sealed ?? '')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir.path, sealed ?? ''), 'utf8')).toContain('sk-canary');
    const instructions = files.find((f) => f.startsWith('instructions-'));
    expect(instructions?.endsWith('.toml')).toBe(true);
    expect(readFileSync(join(dir.path, instructions ?? ''), 'utf8').trim()).toBe(
      '"Say \\"hi\\"\\nthen stop."',
    );
    expect(files.some((f) => f.startsWith('mcp-'))).toBe(false);
    const script = readFileSync(set.script, 'utf8');
    expect(script).not.toContain('/plugins/one');
    expect(script).not.toContain('sk-canary');
    expect(set.line).not.toContain('sk-canary');
  });
});
