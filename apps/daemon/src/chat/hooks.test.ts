import { AccountKind, ChatToolName, JudgeKind } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createJudge, type Judge } from '../judge';
import { silentLogger } from '../log';
import { EMPTY_SETUP, type LaneSandboxSpec } from '../sandbox';
import type { ExploreSessionSpec } from '../sessions';
import type { ShapePrepared } from '../shape';
import { chatProfile } from './hooks';

// Sessions spec §7.1, trust line §5: a chat's session is the attended explore profile: the builder's
// setup, the web, Claude Code's own agents, every chat tool on 10db's server, and nothing that writes.

const SANDBOX: LaneSandboxSpec = {
  settings: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/'],
      allowRead: ['/repo'],
      allowWrite: ['/t/x'],
      denyWrite: ['/repo'],
    },
    network: { allowedDomains: [], allowMachLookup: [], allowUnixSockets: ['/t/x'] },
    credentials: { envVars: [] },
  },
  checkout: '/repo',
  env: {},
  shellEnv: {},
  disallowedTools: [],
  askRules: [],
};

const prepared = (): Promise<ShapePrepared> =>
  Promise.resolve({
    sandbox: SANDBOX,
    commands: {
      protectedPaths: [],
      fileAccess: {
        read: () => 'ok',
        write: () => 'ok',
        readAsk: () => null,
        writeAsk: () => null,
      },
    },
    projectMcpServers: {
      docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: null },
    },
    yourMcpServers: {
      mine: {
        connect: { type: 'http', url: 'https://mine.example.com/mcp', headers: null },
        codex: {
          enabledTools: null,
          disabledTools: [],
          startupTimeoutSec: null,
          toolTimeoutSec: null,
        },
      },
    },
    note: null,
    credentialsExpireAt: null,
    instructions: 'Use pnpm.',
    setup: { ...EMPTY_SETUP, pluginDirs: ['/setup/yours', '/setup/project'] },
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no', by: 'builder' }),
    trackProcesses: () => undefined,
    release: () => Promise.resolve(),
  });

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

/** The spec of the session a chat's first message opens. */
async function firstSpec(
  judge: JudgeKind,
  model: string | null = null,
  tendb?: (w: Pick<ChatWorld, 'store'>) => Judge,
): Promise<ExploreSessionSpec> {
  w = chatWorld({ prepare: prepared, judge, ...(tendb === undefined ? {} : { tendb }) });
  const chat =
    model === null ? w.open() : w.chat.create({ projectId: w.project.id, model, tabPosition: 0 });
  w.chat.send(chat.conversationId, { text: 'Why does login fail?', mentions: [], pictures: [] });
  await w.engine.settled(chat.conversationId);
  const spec = w.adapter.shapeSessions[0]?.spec;
  if (spec === undefined) throw new Error('no session opened');
  return spec;
}

describe("a chat's session", () => {
  it('is the attended explore profile with the setup, the web, agents and every chat tool', async () => {
    const spec = await firstSpec(JudgeKind.Native);
    const { profile } = spec;
    expect(profile.kind).toBe('explore');
    for (const tool of ['WebSearch', 'WebFetch', 'Task', 'Agent', 'Bash']) {
      expect(profile.tools).toContain(tool);
      expect(profile.disallowedTools).not.toContain(tool);
    }
    for (const tool of ['Edit', 'Write']) {
      expect(profile.tools).not.toContain(tool);
      expect(profile.disallowedTools).toContain(tool);
    }
    expect(profile.agents).toEqual({});
    expect(Object.keys(spec.projectMcpServers)).toEqual(['docs']);
    expect(Object.keys(spec.yourMcpServers)).toEqual(['mine']);
    expect(spec.policy.environment.join('\n')).toContain('the MCP servers mine are the builder');
    expect(spec.mcp.url).toBe('http://127.0.0.1:4317/mcp');
    expect(spec.setup?.plugins).toEqual(['/setup/yours', '/setup/project']);
    expect(spec.instructions).toBe('Use pnpm.');
    expect(spec.policy).toMatchObject({ surface: 'chat', attended: true });
    for (const name of Object.values(ChatToolName))
      expect(profile.allowedTools).toContain(`mcp__10db__${name}`);
  });

  // A tendb chat starts on its judge only when 10db's judge is ready: "a chat's judge" below.
  it.each([
    { judge: JudgeKind.Native, web: 'allow' },
    { judge: JudgeKind.Rules, web: 'deny' },
  ])(
    'on a $judge judge it names its judge, and the hook answers the web $web',
    async ({ judge, web }) => {
      const spec = await firstSpec(judge);
      expect(spec.profile.judge).toBe(judge);
      expect(spec.profile.allowedTools).not.toContain('WebSearch');
      expect(
        spec.preToolUse({ toolName: 'WebSearch', input: { query: 'retry login' } }).decision,
      ).toBe(web);
    },
  );

  // Web search stays off on Codex until a live check: a chat there is never told it searches the web.
  it.each([
    { kind: AccountKind.ClaudeSubscription, web: true },
    { kind: AccountKind.CodexSignin, web: false },
  ])('on a $kind account tells the agent it searches the web: $web', async ({ kind, web }) => {
    w = chatWorld({ prepare: prepared, judge: JudgeKind.Tendb });
    w.launchOn(kind);
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Why does login fail?', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    const prompt = w.adapter.shapeSessions[0]?.spec.profile.systemPrompt ?? '';
    expect(prompt.includes('search the web')).toBe(web);
    expect(prompt.includes('no web search')).toBe(!web);
  });

  it("runs on the chat's pick, or the plan role's when it has none", async () => {
    expect((await firstSpec(JudgeKind.Native, 'claude-sonnet-5-5')).model).toBe(
      'claude-sonnet-5-5',
    );
    await w.close();
    expect((await firstSpec(JudgeKind.Native)).model).toBe('claude-opus-5-5');
  });

  it('keeps Bash out with no sandbox', () => {
    const profile = chatProfile(false);
    expect(profile.tools).not.toContain('Bash');
    expect(profile.disallowedTools).toContain('Bash');
  });

  it('refuses a write and the web with no judge, and lets a read through', async () => {
    const spec = await firstSpec(JudgeKind.Rules);
    expect(spec.preToolUse({ toolName: 'Edit', input: { file_path: '/repo/a.ts' } }).decision).toBe(
      'deny',
    );
    expect(spec.preToolUse({ toolName: 'WebSearch', input: { query: 'x' } }).decision).toBe('deny');
    expect(
      spec.preToolUse({ toolName: 'mcp__10db__create_task', input: { title: 'x' } }).decision,
    ).toBe('allow');
  });
});

// Trust line §5: a chat is judged as Plan is: 10db's judge where it is the account's and ready, else the rules.
describe("a chat's judge", () => {
  /** 10db's judge with a key, answering every call with `choice`. */
  const tendbAnswering =
    (choice: string) =>
    ({ store }: Pick<ChatWorld, 'store'>): Judge =>
      createJudge({
        state: createStateStore(store, createEventBus()),
        clock: new ManualClock(),
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'gen-1',
                model: 'typesafe/jev-1.13-20260917',
                provider: 'TypeSafe',
                answers: {
                  decision: {
                    type: 'choice',
                    choice,
                    confidence: 0.95,
                    probabilities: { [choice]: 0.95 },
                  },
                },
                usage: { input_tokens: 300, output_tokens: 10, cost: 0.00002 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
        readKey: () => Promise.resolve('router-key-0123'),
        decisionModelIds: () => new Set(['typesafe/jev-1.13']),
        off: false,
        logger: silentLogger,
      });

  it("starts on the rules when the account's judge is 10db's and it isn't ready", async () => {
    const spec = await firstSpec(JudgeKind.Tendb);
    expect(spec.profile.judge).toBe('rules');
    expect(spec.judgeCall).toBeUndefined();
    expect(spec.preToolUse({ toolName: 'WebSearch', input: { query: 'x' } }).decision).toBe('deny');
  });

  it("is judged by 10db's judge when it is ready: a deploy it stops at a limit asks the builder", async () => {
    const spec = await firstSpec(JudgeKind.Tendb, null, tendbAnswering('writes_live'));
    expect(spec.profile.judge).toBe('tendb');
    const judgeCall = spec.judgeCall;
    if (judgeCall === undefined) throw new Error('the chat has no session judge');
    const verdict = await judgeCall({
      toolName: 'Bash',
      input: { command: 'vercel deploy --prod' },
      cwd: '/repo',
      toolUseId: 'toolu_1',
      signal: new AbortController().signal,
      hunk: null,
    });
    expect(verdict.decision).toBe('ask');
  });
});
