import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { idUuid, mintId, type ToolCallView } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { createTempRepo, type TempDir, testPolicy } from '../../test/fixtures';
import { loadEnv } from '../env';
import {
  AgentTool,
  captureLoginEnv,
  createLauncher,
  ensureAgent,
  systemKeychain,
} from '../environment';
import { createLogger, silentLogger } from '../log';
import { createClaudeAdapter } from './index';
import type { SessionEvent } from './types';

const live = loadEnv(process.env).TENDB_LIVE_CLAUDE === '1';

/** A live session on the default account's login, as the daemon starts one, with what it logs. */
async function liveSession(spec: {
  readonly prompt: string;
  readonly promptUuid?: string;
  readonly repo?: TempDir;
  readonly resume?: string;
  readonly allowedTools?: readonly string[];
}) {
  const login = await captureLoginEnv({ inherited: process.env });
  // The pinned release, as the daemon runs it: this test is what verifies a bump of that pin.
  const claudePath = await ensureAgent(AgentTool.Claude);
  const repo = spec.repo ?? createTempRepo();
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
  const handle = adapter.open({
    sessionId: mintId('Session'),
    policy: testPolicy(),
    profile: {
      kind: 'lane',
      workstreamId: mintId('Workstream'),
      sequence: 1,
      allowedTools: spec.allowedTools ?? [],
    },
    cwd: repo.path,
    prompt: spec.prompt,
    ...(spec.promptUuid === undefined ? {} : { promptUuid: spec.promptUuid }),
    model: launch.model,
    effort: 'low',
    resumeProviderSessionId: spec.resume ?? null,
    env: launch.env,
    account: launch.expect,
    projectMcpServers: {},
    sandbox: null,
    // Nothing listens here; the session runs without 10db's tools.
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () =>
      Promise.resolve({ behavior: 'deny', message: 'No tools in the live test.', by: '10db' }),
  });
  return {
    handle,
    lines,
    repo,
    cleanup: () => {
      repo.cleanup();
    },
  };
}

/** A live Plan session on the default account's login: no settings file, plugin or project server. */
async function livePlanSession(spec: { readonly prompt: string; readonly model?: string }) {
  const login = await captureLoginEnv({ inherited: process.env });
  const claudePath = await ensureAgent(AgentTool.Claude);
  const repo = createTempRepo();
  const adapter = createClaudeAdapter({
    claudePath,
    pluginDir: HARNESS_PLUGIN_DIR,
    logger: silentLogger,
  });
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
  const launch = launcher.session(
    { ...defaultAccount, expectedIdentity: seen.email ?? null },
    spec.model ?? 'claude-haiku-5-5',
    [],
  );
  const handle = adapter.open({
    sessionId: mintId('Session'),
    policy: testPolicy('plan'),
    profile: {
      kind: 'explore',
      shapeId: mintId('Shape'),
      systemPrompt: 'You are helping plan work. Answer briefly.',
      tools: ['Read'],
      allowedTools: [],
      disallowedTools: [],
      agents: {},
    },
    cwd: repo.path,
    prompt: spec.prompt,
    model: launch.model,
    effort: 'low',
    resumeProviderSessionId: null,
    env: launch.env,
    account: launch.expect,
    // Nothing listens here; the session runs without 10db's tools.
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
    sandbox: null,
    projectMcpServers: {},
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () =>
      Promise.resolve({ behavior: 'deny', message: 'No tools in the live test.', by: '10db' }),
  });
  return {
    handle,
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

    // A subscription run can report its rate limit before init, so `started` is the first event
    // besides those limit readings.
    const types = events.map((e) => e.type);
    expect(types.find((t) => t !== 'rate_limit')).toBe('started');
    expect(types).toContain('context');
    expect(types).toContain('turn_complete');
    expect(types.filter((t) => t === 'ended')).toEqual(['ended']);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
    const billing = lines.find((l) => l['msg'] === 'claude session billing');
    expect(billing).toMatchObject({ apiKeySource: 'none', apiProvider: 'firstParty' });
    expect(billing?.['subscriptionType']).toBeTruthy();
    // It streams: the first message's deltas are its text, and the session lists its commands.
    const message = events.find((e) => e.type === 'message');
    if (message?.type !== 'message') throw new Error('no message streamed');
    const deltas = events.flatMap((e) =>
      e.type === 'text_delta' && e.itemId === message.itemId ? [e.text] : [],
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe(message.text);
    const commands = events.find((e) => e.type === 'commands');
    expect(commands?.type === 'commands' ? commands.commands.map((c) => c.name) : []).toContain(
      'compact',
    );
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

  // A message sent with `next` priority while the turn makes tool calls is folded into that turn.
  // The pinned Claude Code stamps it on no later assistant message of a turn a typed prompt started:
  // the turn's result lists it, after the prompt's uuid.
  it("lists a message folded into a turn that makes tool calls on that turn's result", async () => {
    const prompt = idUuid(mintId('TaskMessage'));
    const folded = idUuid(mintId('TaskMessage'));
    const repo = createTempRepo();
    for (const [name, word] of [
      ['one.txt', 'apple'],
      ['two.txt', 'pear'],
      ['three.txt', 'plum'],
    ] as const)
      writeFileSync(join(repo.path, name), `${word}\n`);
    const { handle, cleanup } = await liveSession({
      prompt:
        'Read one.txt, then two.txt, then three.txt with the Read tool, one call at a time, waiting for each result before the next call. Then reply with the three words they hold, in order.',
      promptUuid: prompt,
      repo,
      allowedTools: ['Read'],
    });
    const consumed: string[] = [];
    let sent = false;
    for await (const event of handle.events) {
      if (event.type === 'consumed') consumed.push(...event.uuids);
      if (event.type === 'tool_call' && !sent) {
        sent = true;
        handle.send(
          'When you are done with the files, also reply with the single word: blue',
          [],
          folded,
        );
      }
      if (event.type === 'turn_complete') await handle.stop();
    }
    cleanup();

    expect(sent).toBe(true);
    expect(consumed).toContain(prompt);
    expect(consumed).toContain(folded);
  }, 180_000);

  // Claude Code runs no turn for a message under a uuid its transcript already holds: it
  // acknowledges it and drops it, a resumed conversation's prompt included (the live run saw a
  // resumed session sent its first prompt's uuid again start no turn). A message is sent again,
  // into a resumed conversation or after an interrupt, under a uuid of its own.
  it('runs a turn for a message sent again into a resumed conversation under a uuid of its own', async () => {
    const first = idUuid(mintId('TaskMessage'));
    const again = idUuid(mintId('TaskMessage'));
    const repo = createTempRepo();
    const one = await liveSession({
      prompt: 'Reply with the single word: ready',
      promptUuid: first,
      repo,
    });
    let providerSessionId = '';
    for await (const event of one.handle.events) {
      if (event.type === 'started') providerSessionId = event.providerSessionId;
      if (event.type === 'turn_complete') await one.handle.stop();
    }
    const two = await liveSession({
      prompt: 'Reply with the single word: again',
      promptUuid: again,
      repo,
      resume: providerSessionId,
    });
    const consumed: string[] = [];
    for await (const event of two.handle.events) {
      if (event.type === 'consumed') consumed.push(...event.uuids);
      if (event.type === 'turn_complete') await two.handle.stop();
    }
    two.cleanup();

    expect(providerSessionId).not.toBe('');
    expect(consumed).toContain(again);
  }, 180_000);
  // Claude Code may write the assistant frame before the PreToolUse hook's control request. The card
  // must still diff against the file as it was: a whole file shown as added means the capture lost.
  it('shows a Write over an existing file as a diff of the changed line, not the whole file added', async () => {
    const repo = createTempRepo();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`);
    writeFileSync(join(repo.path, 'notes.txt'), `${lines.join('\n')}\n`);
    const { handle, cleanup } = await liveSession({
      prompt:
        'Read notes.txt with the Read tool, then use the Write tool to write notes.txt again with every line the same except line 10, which becomes: ten. Do nothing else.',
      repo,
      allowedTools: ['Read', 'Write', 'Edit'],
    });
    const edits: ToolCallView[] = [];
    for await (const event of handle.events) {
      if (event.type === 'tool_call' && event.call.kind === 'edit') edits.push(event.call);
      if (event.type === 'turn_complete') await handle.stop();
    }
    cleanup();

    // The call as first shown, the running view built when the frame was mapped.
    expect(edits[0]).toMatchObject({ change: 'update', addedLines: 1, removedLines: 1 });
  }, 180_000);

  // The one Claude core runs Plan's preflight too: the account check, the MCP registration and the
  // first message, against the real SDK.
  it('runs one Plan turn on the real claude, with no settings, plugin or project server', async () => {
    const { handle, cleanup } = await livePlanSession({
      prompt: 'Reply with the single word: ready',
    });
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_complete') await handle.stop();
    }
    cleanup();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types.indexOf('turn_complete')).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
  }, 120_000);
});
