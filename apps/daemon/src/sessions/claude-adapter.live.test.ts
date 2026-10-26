import { mintId } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { createTempRepo } from '../../test/fixtures';
import { loadEnv } from '../env';
import { captureLoginEnv, createLauncher, findOnPath, systemKeychain } from '../environment';
import { createLogger } from '../log';
import { createClaudeAdapter } from './index';
import type { SessionEvent } from './types';

const live = loadEnv(process.env).TENDB_LIVE_CLAUDE === '1';

// Runs on the builder's Max subscription through the logged-in claude; never in CI, never on Bedrock.
describe.skipIf(!live)('Claude adapter, live', () => {
  it('runs one turn on the real claude, billed to the subscription', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = findOnPath('claude', login.vars['PATH']);
    if (!claudePath) throw new Error('claude is not on the login PATH');
    const repo = createTempRepo();
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'info',
      destination: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    const adapter = createClaudeAdapter({ claudePath, pluginDir: HARNESS_PLUGIN_DIR, logger });
    // The default account lives where the builder's login does; a probe reads who that is.
    const launcher = createLauncher({
      base: login.vars,
      clientApp: '10db/live-test',
      keychain: systemKeychain,
    });
    const defaultAccount: AccountRow = {
      id: mintId('Account'),
      kind: 'claude_subscription',
      label: 'Claude plan',
      payer: '',
      expectedIdentity: null,
      configDir: launcher.loginConfigDir(),
      secretRef: null,
      secretFingerprint: null,
      settings: {},
      laneCap: 4,
      monthlyCapUsd: null,
      archived: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const seen = await adapter.probeAccount({
      cwd: repo.path,
      env: launcher.probe(defaultAccount).env,
    });
    expect(seen.email).toBeTruthy();
    const launch = launcher.session(
      { ...defaultAccount, expectedIdentity: seen.email ?? null },
      'haiku',
    );
    const handle = adapter.start({
      sessionId: mintId('Session'),
      workstreamId: mintId('Workstream'),
      sequence: 1,
      cwd: repo.path,
      prompt: 'Reply with the single word: ready',
      model: launch.model,
      effort: 'low',
      resumeProviderSessionId: null,
      env: launch.env,
      account: launch.expect,
      projectMcpServers: {},
      allowedTools: [],
      // Nothing listens here; the session runs without 10db's tools.
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
      preToolUse: () => ({ decision: 'allow' }),
      canUseTool: () =>
        Promise.resolve({ behavior: 'deny', message: 'No tools in the live test.' }),
    });
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      const turned = events.some((e) => e.type === 'turn_complete');
      const measured = events.some((e) => e.type === 'context');
      if (turned && measured) await handle.stop();
    }
    repo.cleanup();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types).toContain('context');
    expect(types).toContain('turn_complete');
    expect(types.filter((t) => t === 'ended')).toEqual(['ended']);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
    const billing = lines.find((l) => l['msg'] === 'claude session billing');
    expect(billing).toMatchObject({ apiKeySource: 'none', apiProvider: 'firstParty' });
    expect(billing?.['subscriptionType']).toBeTruthy();
  }, 120_000);
});
