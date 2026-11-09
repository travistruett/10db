import { idUuid, mintId } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { createTempRepo } from '../../test/fixtures';
import { loadEnv } from '../env';
import {
  AgentTool,
  captureLoginEnv,
  createLauncher,
  ensureAgent,
  systemKeychain,
} from '../environment';
import { createLogger } from '../log';
import { createClaudeAdapter } from './index';
import type { SessionEvent } from './types';

const live = loadEnv(process.env).TENDB_LIVE_CLAUDE === '1';

/** A live session on the default account's login, as the daemon starts one, with what it logs. */
async function liveSession(spec: { readonly prompt: string; readonly promptUuid?: string }) {
  const login = await captureLoginEnv({ inherited: process.env });
  // The pinned release, as the daemon runs it: this test is what verifies a bump of that pin.
  const claudePath = await ensureAgent(AgentTool.Claude);
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
  // This test checks the adapter's own wiring against the real claude, with a prompt that runs no
  // command; `test/lane-sandbox.live.test.ts` covers the sandboxed session.
  const adapter = createClaudeAdapter({
    claudePath,
    pluginDir: HARNESS_PLUGIN_DIR,
    logger,
    allowUnsandboxed: true,
  });
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
    kind: defaultAccount.kind,
    cwd: repo.path,
    env: launcher.probe(defaultAccount).env,
  });
  expect(seen.email).toBeTruthy();
  const launch = launcher.session(
    { ...defaultAccount, expectedIdentity: seen.email ?? null },
    'claude-haiku-5-5',
    [],
  );
  const handle = adapter.start({
    sessionId: mintId('Session'),
    workstreamId: mintId('Workstream'),
    sequence: 1,
    cwd: repo.path,
    prompt: spec.prompt,
    ...(spec.promptUuid === undefined ? {} : { promptUuid: spec.promptUuid }),
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
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'No tools in the live test.' }),
  });
  return {
    handle,
    lines,
    cleanup: () => {
      repo.cleanup();
    },
  };
}

// Runs on the builder's Max subscription through the logged-in claude; never in CI, never on Bedrock.
describe.skipIf(!live)('Claude adapter, live', () => {
  it('runs one turn on the real claude, billed to the subscription', async () => {
    const { handle, lines, cleanup } = await liveSession({
      prompt: 'Reply with the single word: ready',
    });
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      const turned = events.some((e) => e.type === 'turn_complete');
      const measured = events.some((e) => e.type === 'context');
      if (turned && measured) await handle.stop();
    }
    cleanup();

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

  // Workbench spec §6.3: a builder message is delivered on the evidence a turn took it, the uuid an
  // assistant message stamps in `user_message_uuids`, never because it was pushed.
  it('stamps the uuid of a message sent mid-turn and of one sent as a turn ends, and answers an interrupt with a receipt', async () => {
    const prompt = idUuid(mintId('TaskMessage'));
    const midTurn = idUuid(mintId('TaskMessage'));
    const atTurnEnd = idUuid(mintId('TaskMessage'));
    const { handle, cleanup } = await liveSession({
      prompt: 'Write the numbers from 1 to 30, one per line, and nothing else.',
      promptUuid: prompt,
    });
    const consumed: string[] = [];
    let sentMidTurn = false;
    let sentAtTurnEnd = false;
    let turns = 0;
    for await (const event of handle.events) {
      if (event.type === 'consumed') consumed.push(...event.uuids);
      if (event.type === 'activity' && !sentMidTurn) {
        sentMidTurn = true;
        handle.send('Then reply with the single word: blue', [], midTurn);
      }
      if (event.type !== 'turn_complete') continue;
      turns += 1;
      if (!sentAtTurnEnd) {
        sentAtTurnEnd = true;
        handle.send('Reply with the single word: green', [], atTurnEnd);
      }
      if (consumed.includes(atTurnEnd) || turns >= 4) {
        // The pinned Claude Code advertises `interrupt_receipt_v1`: an interrupt answers a receipt.
        expect(await handle.interrupt()).toEqual({ stillQueued: expect.any(Array) as string[] });
        await handle.stop();
      }
    }
    cleanup();

    expect(consumed).toContain(prompt);
    expect(consumed).toContain(midTurn);
    expect(consumed).toContain(atTurnEnd);
    expect(consumed.indexOf(prompt)).toBeLessThan(consumed.indexOf(atTurnEnd));
  }, 180_000);
});
