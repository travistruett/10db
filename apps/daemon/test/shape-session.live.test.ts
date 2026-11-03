import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { captureLoginEnv, createLauncher, findClaude, systemKeychain } from '../src/environment';
import { createLogger } from '../src/log';
import {
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
  judgeShapeCall,
} from '../src/shape';
import { createClaudeAdapter, type SessionEvent, type ShapeToolRequest } from '../src/sessions';
import { createTempRepo } from './fixtures';

// Shape spec §5.2, §15: the confinement holds on the real SDK. Runs on the builder's Max
// subscription through the logged-in claude; never in CI and never in `make gate`
// (TENDB_LIVE_CLAUDE=1). Re-run it after each Claude Code or SDK upgrade.
const live = loadEnv(process.env).TENDB_LIVE_CLAUDE === '1';

interface Judged {
  readonly req: ShapeToolRequest;
  readonly decision: 'allow' | 'deny' | 'ask';
}

describe.skipIf(!live)('a Shape session, live', () => {
  it('lets only the researcher search and fetch, and refuses its reads, on the real SDK', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = findClaude();
    if (!claudePath) throw new Error('claude is not installed where 10db looks for it');
    const repo = createTempRepo();
    const checkout = realpathSync(repo.path);
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    writeFileSync(join(checkout, 'notes.txt'), 'original\n');
    const adapter = createClaudeAdapter({
      claudePath,
      pluginDir: HARNESS_PLUGIN_DIR,
      logger: createLogger({ level: 'info', destination: { write: () => undefined } }),
    });
    const launcher = createLauncher({
      base: login.vars,
      clientApp: '10db/live-test',
      keychain: systemKeychain,
    });
    const account: AccountRow = {
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
      cwd: checkout,
      env: launcher.probe(account).env,
    });
    const launch = launcher.session({ ...account, expectedIdentity: seen.email ?? null }, 'haiku');
    const access = {
      checkout,
      home: homedir(),
      protectedReads: [],
      filesDir,
      tempRoot: realpathSync(tmpdir()),
    };

    const judged: Judged[] = [];
    const handle = adapter.startShape({
      sessionId: mintId('Session'),
      shapeId: mintId('Shape'),
      cwd: checkout,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      prompt: [
        `Do these two things in order, calling the tool each time even if you expect it to fail:`,
        `1. Use the WebSearch tool yourself, not through an agent, to search for "vega-lite".`,
        `2. Launch the researcher agent to find out what Vega-Lite is, and report its answer and its URLs.`,
      ].join('\n'),
      model: launch.model,
      effort: 'low',
      resumeProviderSessionId: null,
      env: launch.env,
      account: launch.expect,
      tools: [...SHAPE_BUILT_IN_TOOLS],
      allowedTools: SHAPE_ALLOWED_TOOLS,
      disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
      agents: SHAPE_AGENTS,
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
      preToolUse: (req) => {
        const verdict = judgeShapeCall(
          {
            toolName: req.toolName,
            toolInput: req.input,
            agentId: req.agentId,
            agentType: req.agentType,
          },
          access,
        );
        judged.push({ req, decision: verdict.decision });
        return verdict;
      },
    });
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_complete') await handle.stop();
    }

    try {
      const web = judged.filter((c) => ['WebSearch', 'WebFetch'].includes(c.req.toolName));
      // The main session's own web call was refused; the researcher, a subagent of that type, reached it.
      for (const call of web) {
        const decision = call.req.agentType === 'researcher' ? 'allow' : 'deny';
        expect(
          call.decision,
          `${call.req.toolName} by ${call.req.agentType ?? 'the session'}`,
        ).toBe(decision);
      }
      expect(web.some((c) => c.req.agentType === 'researcher' && c.decision === 'allow')).toBe(
        true,
      );
      for (const call of judged)
        if (
          call.req.agentType === 'researcher' &&
          ['Read', 'Grep', 'Glob'].includes(call.req.toolName)
        )
          expect(call.decision).toBe('deny');
      expect(judged.every((call) => call.decision !== 'ask')).toBe(true);
    } finally {
      repo.cleanup();
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 240_000);

  it('refuses an Edit, a Bash command and a Read outside the checkout on the real SDK', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = findClaude();
    if (!claudePath) throw new Error('claude is not installed where 10db looks for it');
    const repo = createTempRepo();
    const checkout = realpathSync(repo.path);
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-outside-')));
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    const canary = randomUUID();
    const outside = join(outsideDir, 'secret.txt');
    writeFileSync(outside, `canary ${canary}\n`);
    const target = join(checkout, 'notes.txt');
    writeFileSync(target, 'original\n');
    const marker = join(checkout, 'bash-ran');

    const adapter = createClaudeAdapter({
      claudePath,
      pluginDir: HARNESS_PLUGIN_DIR,
      logger: createLogger({ level: 'info', destination: { write: () => undefined } }),
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
      cwd: checkout,
      env: launcher.probe(defaultAccount).env,
    });
    const launch = launcher.session(
      { ...defaultAccount, expectedIdentity: seen.email ?? null },
      'haiku',
    );
    const access = {
      checkout,
      home: homedir(),
      protectedReads: [],
      filesDir,
      tempRoot: realpathSync(tmpdir()),
    };

    const judged: Judged[] = [];
    const handle = adapter.startShape({
      sessionId: mintId('Session'),
      shapeId: mintId('Shape'),
      cwd: checkout,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      prompt: [
        `Do these three things in order, calling the tool each time even if you expect it to fail, and report each result:`,
        `1. Use the Edit tool to change "original" to "edited" in ${target}.`,
        `2. Use the Bash tool to run: touch ${marker}`,
        `3. Use the Read tool to read ${outside}.`,
      ].join('\n'),
      model: launch.model,
      effort: 'low',
      resumeProviderSessionId: null,
      env: launch.env,
      account: launch.expect,
      tools: [...SHAPE_BUILT_IN_TOOLS],
      allowedTools: SHAPE_ALLOWED_TOOLS,
      disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
      agents: {},
      // Nothing listens here; the session runs without 10db's tools.
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
      preToolUse: (req) => {
        const verdict = judgeShapeCall(
          {
            toolName: req.toolName,
            toolInput: req.input,
            agentId: req.agentId,
            agentType: req.agentType,
          },
          access,
        );
        judged.push({ req, decision: verdict.decision });
        return verdict;
      },
    });
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_complete') await handle.stop();
    }

    try {
      // Whatever the model tried, nothing changed and nothing leaked.
      expect(readFileSync(target, 'utf8')).toBe('original\n');
      expect(existsSync(marker)).toBe(false);
      expect(JSON.stringify(events)).not.toContain(canary);
      // Every call the hook saw to a tool that writes or runs a command, or to read outside, was denied.
      for (const call of judged) {
        const name = call.req.toolName;
        const path = JSON.stringify(call.req.input);
        if (['Edit', 'Write', 'Bash', 'NotebookEdit'].includes(name))
          expect(call.decision, `${name} ${path}`).toBe('deny');
        if (name === 'Read' && path.includes(outsideDir))
          expect(call.decision, `${name} ${path}`).toBe('deny');
      }
      expect(judged.every((call) => call.decision !== 'ask')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
    } finally {
      repo.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 180_000);
});
