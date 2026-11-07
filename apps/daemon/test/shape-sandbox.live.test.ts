import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId, PermissionChoice, ShapeOrigin } from '@10db/contracts';
import { createTestStore, insertShape, seedProject, type AccountRow } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { describe, expect, it } from 'vitest';
import { allSandboxRootsOf, openSandboxRoots, sandboxDepsOf } from '../src/daemon';
import { createShapePreparer } from '../src/daemon/shape-session-tools';
import { loadEnv } from '../src/env';
import { captureLoginEnv, createLauncher, findClaude, systemKeychain } from '../src/environment';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { protectedPaths } from '../src/guard';
import { createInboxService } from '../src/inbox';
import { createLogger, silentLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import { claimSandboxRoots, createLaneSandbox } from '../src/sandbox';
import { createClaudeAdapter, type ShapeToolRequest } from '../src/sessions';
import {
  judgeShapeCall,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
  shapeToolset,
} from '../src/shape';
import { createTempRepo } from './fixtures';

// Shape spec §5.2, §15: a Plan session's commands, in its read-only lane sandbox and through the lanes'
// broker, on the real SDK and the real srt. Runs on the builder's Max subscription through the
// logged-in claude; never in CI and never in `make gate` (TENDB_LIVE_CLAUDE=1). Re-run it after each
// Claude Code or SDK upgrade.
const live = loadEnv(process.env).TENDB_LIVE_CLAUDE === '1';

interface Judged {
  readonly req: ShapeToolRequest;
  readonly decision: 'allow' | 'deny' | 'ask';
}

const commandOf = (req: ShapeToolRequest): string => {
  const input = req.input;
  return typeof input === 'object' && input !== null && 'command' in input
    ? String(input.command)
    : '';
};

describe.skipIf(!live)('a Plan session in its read-only sandbox, live', () => {
  it('runs a read-only command, cards one that is not and keeps it off the checkout, and fans out a code researcher on a named model', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = findClaude();
    if (!claudePath) throw new Error('claude is not installed where 10db looks for it');
    const repo = createTempRepo();
    const checkout = realpathSync(repo.path);
    writeFileSync(join(checkout, 'notes.txt'), 'original\n');
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-plan-live-data-')));
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-plan-live-files-')));
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
      kind: account.kind,
      cwd: checkout,
      env: launcher.probe(account).env,
    });
    const launch = launcher.session(
      { ...account, expectedIdentity: seen.email ?? null },
      'claude-haiku-5-5',
      [],
    );

    const test = createTestStore();
    const state = createStateStore(test.store, createEventBus());
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
    const project = seedProject(test.store, { repoPath: checkout });
    const shape = test.store.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Live', origin: ShapeOrigin.App }),
    ).value;
    const guarded = protectedPaths({
      dataDir,
      home: homedir(),
      loginConfigDir: launcher.loginConfigDir(),
    });
    // The daemon's own roots, marked as a running daemon's so a test daemon that starts meanwhile
    // leaves the session's files alone.
    const roots = openSandboxRoots({}, homedir());
    if (roots.refusal !== null) throw roots.refusal;
    const claim = claimSandboxRoots([roots.temp, roots.codexLanes, roots.files]);
    const prepare = createShapePreparer({
      state,
      inbox,
      git: createGit(),
      logger: silentLogger,
      laneSandbox: createLaneSandbox({
        home: homedir(),
        dataDir,
        loginConfigDir: launcher.loginConfigDir(),
        ...sandboxDepsOf(roots),
        gitDirs: (path) => createGit().gitDirs(path),
        runtime: resolveSandboxRuntime(),
        worktreeRoot: join(dataDir, 'worktrees'),
      }),
      protectedPaths: guarded,
      projectEnv: () => launcher.projectEnv(),
      exportAwsCredentials: () => Promise.reject(new Error('no AWS in this test')),
    });
    const cards: { title: string; shapeId: unknown }[] = [];
    const prepared = await prepare({
      projectId: project.id,
      shapeId: shape.id,
      sessionId: mintId('Session'),
      accountKind: account.kind,
      env: launch.env,
      resumeProviderSessionId: null,
      signal: new AbortController().signal,
      // The builder, answering every card at once: allow it this once.
      observer: {
        onWaitStart: (item) => {
          cards.push({ title: item.title, shapeId: item.detail?.['shapeId'] });
          queueMicrotask(() => {
            inbox.answer(item.id, { choice: PermissionChoice.AllowOnce });
          });
        },
        onWaitEnd: () => undefined,
      },
    });
    const { commands, sandbox } = prepared;
    if (commands === undefined || sandbox === null)
      throw new Error('the Plan sandbox was not built');
    const access = {
      checkout,
      home: homedir(),
      protectedReads: guarded.map((p) => p.path),
      filesDir,
      sandboxRoots: allSandboxRootsOf(roots),
      commands,
    };
    const toolset = shapeToolset(true);
    const judged: Judged[] = [];
    let reply = '';
    try {
      const handle = adapter.startShape({
        sessionId: mintId('Session'),
        shapeId: shape.id,
        cwd: checkout,
        systemPrompt: SHAPE_SYSTEM_PROMPT,
        prompt: [
          'Do these three things in order, calling the tool each time even if you expect it to fail:',
          '1. Run `git log --oneline -1` with the Bash tool yourself.',
          '2. Run `echo changed > notes.txt` with the Bash tool yourself.',
          '3. Launch one Agent with subagent_type "code-researcher" and model "haiku", asking it to run `git log --oneline -1` with Bash and report the output.',
          'Then say in one line what each step returned.',
        ].join('\n'),
        model: launch.model,
        effort: 'low',
        resumeProviderSessionId: null,
        env: launch.env,
        account: launch.expect,
        tools: [...toolset.tools],
        allowedTools: SHAPE_ALLOWED_TOOLS,
        disallowedTools: [...toolset.disallowedTools],
        agents: toolset.agents,
        mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
        sandbox,
        projectMcpServers: prepared.projectMcpServers,
        canUseTool: (req) => prepared.canUseTool(req),
        preToolUse: (req) => {
          const verdict = judgeShapeCall(
            {
              toolName: req.toolName,
              toolInput: req.input,
              agentId: req.agentId,
              agentType: req.agentType,
              cwd: req.cwd,
            },
            access,
          );
          judged.push({ req, decision: verdict.decision });
          return verdict;
        },
      });
      for await (const event of handle.events) {
        if (event.type === 'turn_complete') {
          reply = event.text ?? '';
          await handle.stop();
        }
      }
    } finally {
      await prepared.release();
      claim.release();
      test.close();
    }
    const bash = judged.filter((j) => j.req.toolName === 'Bash');
    const own = bash.filter((j) => j.req.agentId === undefined);
    expect(own.find((j) => commandOf(j.req).startsWith('git log'))?.decision).toBe('allow');
    expect(own.find((j) => commandOf(j.req).includes('notes.txt'))?.decision).toBe('ask');
    expect(cards).toEqual([{ title: 'Allow Bash?', shapeId: shape.id }]);
    // Allowed on the card, the write still met the sandbox, which keeps the checkout read-only.
    expect(readFileSync(join(checkout, 'notes.txt'), 'utf8')).toBe('original\n');
    const launched = judged.find((j) => j.req.toolName === 'Agent');
    expect(launched?.decision).toBe('allow');
    expect(launched?.req.input).toMatchObject({ subagent_type: 'code-researcher', model: 'haiku' });
    expect(
      bash.find(
        (j) => j.req.agentType === 'code-researcher' && commandOf(j.req).startsWith('git log'),
      )?.decision,
    ).toBe('allow');
    expect(reply).not.toBe('');
    repo.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(filesDir, { recursive: true, force: true });
  }, 300_000);
});
