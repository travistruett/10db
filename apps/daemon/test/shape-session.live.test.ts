import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentKind, mintId } from '@10db/contracts';
import {
  createTestStore,
  insertSession,
  insertShape,
  seedProject,
  type AccountRow,
} from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import {
  AgentTool,
  captureLoginEnv,
  createLauncher,
  ensureAgent,
  systemKeychain,
} from '../src/environment';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { protectedPaths } from '../src/guard';
import { createInboxService } from '../src/inbox';
import { createLogger, silentLogger } from '../src/log';
import { createMcpHandler, mintSessionToken, ToolImages } from '../src/mcp';
import {
  READ_CHARGE_MAX_BYTES,
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  judgeShapeCall,
  shapeAgentModels,
  shapeSystemPrompt,
} from '../src/shape';
import { createClaudeAdapter, type SessionEvent, type ShapeToolRequest } from '../src/sessions';
import { createTempRepo } from './fixtures';
import { textPdf } from './pdf';
import { noisePng, pngImage } from './png';

/** The prompt for a subscription, whose agents take every alias. */
const SHAPE_SYSTEM_PROMPT = shapeSystemPrompt(shapeAgentModels('claude_subscription'));

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
    const claudePath = await ensureAgent(AgentTool.Claude);
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
      kind: agentKind(account.kind),
      cwd: checkout,
      env: launcher.probe(account).env,
    });
    const launch = launcher.session(
      { ...account, expectedIdentity: seen.email ?? null },
      'claude-haiku-5-5',
      [],
    );
    const access = {
      checkout,
      home: homedir(),
      protectedReads: [],
      filesDir,
      sandboxRoots: [realpathSync(tmpdir())],
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
      sandbox: null,
      projectMcpServers: {},
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no broker here' }),
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

  it('hands the picture see_screen answers to the model, which alone can say what is on it', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = await ensureAgent(AgentTool.Claude);
    const repo = createTempRepo();
    const checkout = realpathSync(repo.path);
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    const test = createTestStore();
    const state = createStateStore(test.store, createEventBus());
    const project = seedProject(test.store, { repoPath: checkout });
    const shape = state.write((ctx) =>
      insertShape(ctx, project.id, { title: 'A look', origin: 'app' }),
    );
    const { token, hash } = mintSessionToken();
    state.write((ctx) =>
      insertSession(ctx, {
        shapeId: shape.id,
        provider: 'claude',
        model: 'haiku',
        effort: 'low',
        mode: 'managed',
        mcpTokenHash: hash,
      }),
    );
    // The tool's text says nothing of the picture: left red and right blue reach the model only as an image.
    const picture = pngImage(600, 400).toString('base64');
    const server = serve({
      fetch: createMcpHandler({
        protectedPaths: protectedPaths({
          dataDir: filesDir,
          home: homedir(),
          loginConfigDir: null,
        }),
        state,
        inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
        git: createGit(),
        log: silentLogger,
        waitObserverFor: () => undefined,
        askedToHandOff: () => undefined,
        sessionSignal: () => undefined,
        shapeTools: () => ({
          see_screen: () =>
            Promise.resolve(
              new ToolImages('Here is the picture.', [{ mediaType: 'image/png', data: picture }]),
            ),
        }),
      }),
      hostname: '127.0.0.1',
      port: 0,
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

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
      kind: agentKind(account.kind),
      cwd: checkout,
      env: launcher.probe(account).env,
    });
    const launch = launcher.session(
      { ...account, expectedIdentity: seen.email ?? null },
      'claude-haiku-5-5',
      [],
    );
    const access = {
      checkout,
      home: homedir(),
      protectedReads: [],
      filesDir,
      sandboxRoots: [realpathSync(tmpdir())],
    };

    const judged: Judged[] = [];
    const handle = adapter.startShape({
      sessionId: mintId('Session'),
      shapeId: shape.id,
      cwd: checkout,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      prompt:
        'Call see_screen with screen "board". Then answer in one line: what colour fills the left half of the picture, and what colour fills the right half? If you received no picture, say NO PICTURE instead.',
      model: launch.model,
      effort: 'low',
      resumeProviderSessionId: null,
      env: launch.env,
      account: launch.expect,
      tools: [...SHAPE_BUILT_IN_TOOLS],
      allowedTools: SHAPE_ALLOWED_TOOLS,
      disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
      agents: {},
      mcp: { url: `http://127.0.0.1:${String(port)}/mcp`, token, toolTimeoutMs: 30_000 },
      sandbox: null,
      projectMcpServers: {},
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no broker here' }),
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
    let reply = '';
    for await (const event of handle.events) {
      if (event.type === 'turn_complete') {
        reply = event.text ?? '';
        await handle.stop();
      }
    }

    try {
      expect(
        judged.some((c) => c.req.toolName === 'mcp__10db__see_screen' && c.decision === 'allow'),
      ).toBe(true);
      expect(reply).not.toContain('NO PICTURE');
      expect(reply).toMatch(/red/i);
      expect(reply).toMatch(/blue/i);
      expect(reply.search(/red/i)).toBeLessThan(reply.search(/blue/i));
    } finally {
      server.close();
      test.close();
      repo.cleanup();
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses an Edit, a Bash command and a Read outside the checkout on the real SDK', async () => {
    const login = await captureLoginEnv({ inherited: process.env });
    const claudePath = await ensureAgent(AgentTool.Claude);
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
      kind: agentKind(defaultAccount.kind),
      cwd: checkout,
      env: launcher.probe(defaultAccount).env,
    });
    const launch = launcher.session(
      { ...defaultAccount, expectedIdentity: seen.email ?? null },
      'claude-haiku-5-5',
      [],
    );
    const access = {
      checkout,
      home: homedir(),
      protectedReads: [],
      filesDir,
      sandboxRoots: [realpathSync(tmpdir())],
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
      sandbox: null,
      projectMcpServers: {},
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no broker here' }),
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

  // Shape spec §5.4: what a picture read with Read adds to a request the session resends. The hook charges
  // a Read at most READ_CHARGE_MAX_BYTES (read-budget.ts); this reads the picture Claude Code put in
  // the session's own transcript file, which is what it resends, and fails if it is larger. It prints the
  // sizes it found so the allowance can be set from them.
  it('returns a read picture within the size the hook charges for it', async () => {
    const repo = createTempRepo();
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    // A 6 MB picture that cannot be compressed, a small one, and a 4000 px wide one.
    const big = join(filesDir, 'big.png');
    const small = join(filesDir, 'small.png');
    const wide = join(filesDir, 'wide.png');
    writeFileSync(big, noisePng(1400, 1400));
    writeFileSync(small, pngImage(600, 400));
    writeFileSync(wide, noisePng(4000, 600));

    try {
      const { transcript } = await readInSession(
        repo.path,
        filesDir,
        `Use the Read tool on each of these in turn, then say "done": ${big}, ${small}, ${wide}`,
      );
      const sizes = imageBlockBytes(transcript);
      console.log(
        `Read pictures in the session's transcript, bytes before base64: ${JSON.stringify(sizes)}`,
      );
      // All three: the allowance is proven by the large pictures, not by the small one alone.
      expect(sizes).toHaveLength(3);
      for (const size of sizes) expect(size).toBeLessThanOrEqual(READ_CHARGE_MAX_BYTES);
    } finally {
      repo.cleanup();
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 240_000);

  // Shape spec §5.4: what a PDF Read adds to a request the session resends. The hook charges a page
  // READ_CHARGE_MAX_BYTES and refuses a Read that names no pages (read-budget.ts). These find what
  // Claude Code stored for the Read and print it, so the charge can be set from it.
  it('returns the pages of a many-page PDF within the charge for each page', async () => {
    const repo = createTempRepo();
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    const long = join(filesDir, 'long.pdf');
    writeFileSync(long, textPdf(40));

    try {
      const { transcript, reads } = await readInSession(
        repo.path,
        filesDir,
        `Use the Read tool once on ${long} with its pages parameter set to "2-4", then say "done".`,
      );
      const blocks = mediaBlocks(transcript);
      console.log(
        `A 3-page Read of a ${String(statSync(long).size)} byte, 40-page PDF, bytes before base64: ${JSON.stringify(blocks)}`,
      );
      expect(reads.map((read) => read.input)).toEqual([{ file_path: long, pages: '2-4' }]);
      expect(blocks).toHaveLength(3);
      for (const block of blocks) {
        expect(block.type).toBe('image');
        expect(block.bytes).toBeLessThanOrEqual(READ_CHARGE_MAX_BYTES);
      }
    } finally {
      repo.cleanup();
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 240_000);

  it('returns a small PDF read whole within the charge for its pages', async () => {
    // The hook refuses this Read today; what it returns says whether a whole Read could be charged instead.
    const repo = createTempRepo();
    const filesDir = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-live-files-')));
    const short = join(filesDir, 'short.pdf');
    writeFileSync(short, textPdf(3));

    try {
      const { transcript } = await readInSession(
        repo.path,
        filesDir,
        `Use the Read tool once on ${short}, with no pages parameter, then say "done".`,
      );
      const blocks = mediaBlocks(transcript);
      console.log(
        `A whole Read of a ${String(statSync(short).size)} byte, 3-page PDF, bytes before base64: ${JSON.stringify(blocks)}`,
      );
      expect(blocks).not.toHaveLength(0);
      const gained = blocks.reduce((sum, block) => sum + block.bytes, 0);
      expect(gained).toBeLessThanOrEqual(3 * READ_CHARGE_MAX_BYTES);
    } finally {
      repo.cleanup();
      rmSync(filesDir, { recursive: true, force: true });
    }
  }, 240_000);
});

/** Runs one turn of a real Shape session and gives back its stored transcript and the Reads it made. */
async function readInSession(
  repoPath: string,
  filesDir: string,
  prompt: string,
): Promise<{ transcript: string; reads: readonly ShapeToolRequest[] }> {
  const login = await captureLoginEnv({ inherited: process.env });
  const claudePath = await ensureAgent(AgentTool.Claude);
  const checkout = realpathSync(repoPath);
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
    kind: agentKind(account.kind),
    cwd: checkout,
    env: launcher.probe(account).env,
  });
  const launch = launcher.session(
    { ...account, expectedIdentity: seen.email ?? null },
    'claude-haiku-5-5',
    [],
  );
  const access = {
    checkout,
    home: homedir(),
    protectedReads: [],
    filesDir,
    sandboxRoots: [realpathSync(tmpdir())],
  };

  let providerSessionId = '';
  const reads: ShapeToolRequest[] = [];
  const handle = adapter.startShape({
    sessionId: mintId('Session'),
    shapeId: mintId('Shape'),
    cwd: checkout,
    systemPrompt: SHAPE_SYSTEM_PROMPT,
    prompt,
    model: launch.model,
    effort: 'low',
    resumeProviderSessionId: null,
    env: launch.env,
    account: launch.expect,
    tools: [...SHAPE_BUILT_IN_TOOLS],
    allowedTools: SHAPE_ALLOWED_TOOLS,
    disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
    agents: {},
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused', toolTimeoutMs: 5_000 },
    sandbox: null,
    projectMcpServers: {},
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no broker here' }),
    preToolUse: (req) => {
      if (req.toolName === 'Read') reads.push(req);
      return judgeShapeCall(
        {
          toolName: req.toolName,
          toolInput: req.input,
          agentId: req.agentId,
          agentType: req.agentType,
        },
        access,
      );
    },
  });
  for await (const event of handle.events) {
    if (event.type === 'started') providerSessionId = event.providerSessionId;
    if (event.type === 'turn_complete') await handle.stop();
  }
  expect(providerSessionId).not.toBe('');
  // Null is the ordinary case: Claude Code then keeps its config in ~/.claude.
  const configDir = launcher.loginConfigDir() ?? join(homedir(), '.claude');
  return {
    transcript: readFileSync(findTranscript(configDir, providerSessionId), 'utf8'),
    reads,
  };
}

/** The session's transcript file under Claude Code's config dir: `projects/<project>/<id>.jsonl`. */
function findTranscript(configDir: string, providerSessionId: string): string {
  const projects = join(configDir, 'projects');
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${providerSessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  throw new Error(`no transcript for session ${providerSessionId} under ${projects}`);
}

interface MediaBlock {
  readonly type: 'image' | 'document';
  readonly bytes: number;
}

/** The decoded size of each image or document block in a value from a transcript. */
function blocksIn(value: unknown): MediaBlock[] {
  if (Array.isArray(value)) return value.flatMap(blocksIn);
  if (typeof value !== 'object' || value === null) return [];
  const block = value as { type?: unknown; source?: { data?: unknown } };
  if (
    (block.type === 'image' || block.type === 'document') &&
    typeof block.source?.data === 'string'
  )
    return [{ type: block.type, bytes: Buffer.from(block.source.data, 'base64').length }];
  return Object.values(value).flatMap(blocksIn);
}

/** The content parts of a transcript's user entries. */
function userContent(jsonl: string): { type?: unknown; content?: unknown }[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type?: unknown; message?: { content?: unknown } })
    .flatMap((entry) =>
      entry.type === 'user' && Array.isArray(entry.message?.content)
        ? (entry.message.content as { type?: unknown; content?: unknown }[])
        : [],
    );
}

/** The decoded size of each image in a tool result: an image the user sent in a message is not a Read. */
function imageBlockBytes(jsonl: string): number[] {
  return userContent(jsonl)
    .filter((part) => part.type === 'tool_result')
    .flatMap((part) => blocksIn(part.content))
    .filter((block) => block.type === 'image')
    .map((block) => block.bytes);
}

/**
 * Every image or document block in the user entries, tool results or not, since a PDF's block may arrive
 * beside its tool result. The prompts these tests send carry none, so all of them come from the Read.
 */
function mediaBlocks(jsonl: string): MediaBlock[] {
  return blocksIn(userContent(jsonl));
}
