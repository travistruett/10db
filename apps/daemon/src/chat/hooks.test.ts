import {
  AccountKind,
  TRUST_DEFAULTS,
  ChatToolName,
  ConversationItemKind,
  JudgeKind,
  parseItemBody,
} from '@10db/contracts';
import { listItems } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createJudge, type Judge } from '../judge';
import { setAppTrustSwitches } from '../permissions';
import { silentLogger } from '../log';
import { EMPTY_SETUP, type LaneSandboxSpec } from '../sandbox';
import type { ExploreSessionSpec } from '../sessions';
import type { ShapePrepared } from '../shape';
import { chatProfile, JOBS_STOP_DEADLINE_MS } from './hooks';

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
        claudeOAuth: null,
        codex: {
          enabledTools: null,
          disabledTools: [],
          startupTimeoutSec: null,
          toolTimeoutSec: null,
        },
      },
    },
    claudeConnectors: true,
    note: null,
    credentialsExpireAt: null,
    instructions: 'Use pnpm.',
    setup: { ...EMPTY_SETUP, pluginDirs: ['/setup/yours', '/setup/project'] },
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no', by: 'builder' }),
    trackProcesses: () => undefined,
    markOwn: () => {
      jobs.marks += 1;
    },
    endJobs: () => {
      jobs.ends += 1;
      return jobs.stopping ?? Promise.resolve();
    },
    release: () => {
      jobs.releases += 1;
      return Promise.resolve();
    },
  });

/** What the session's preparation was told about its jobs, and how the stop of them answers. */
const jobs: {
  marks: number;
  ends: number;
  releases: number;
  stopping: Promise<void> | null;
} = { marks: 0, ends: 0, releases: 0, stopping: null };

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
  // 10db's own git work holds Your folder, so the session opens read-only and its hook answers as a read-only chat's.
  w.folderHold.reserveGit(w.project.id, 'cutting a branch');
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
    // The file tools are on offer in a sandboxed chat, judged at each call by whether its turn holds the folder,
    // and never on an allow rule, which would approve them before the judge sees them.
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(profile.tools).toContain(tool);
      expect(profile.allowedTools).not.toContain(tool);
    }
    expect(profile.disallowedTools).toEqual(['Monitor']);
    expect(profile.agents).toEqual({});
    expect(Object.keys(spec.projectMcpServers)).toEqual(['docs']);
    expect(Object.keys(spec.yourMcpServers)).toEqual(['mine']);
    expect(spec.policy.environment.join('\n')).toContain('the MCP servers mine are the builder');
    // A plan account takes the connectors the preparation allowed, and the policy names them.
    expect(spec.claudeConnectors).toBe(true);
    expect(spec.policy.environment.join('\n')).toContain('claude.ai connectors');
    expect(spec.mcp.url).toBe('http://127.0.0.1:4317/mcp');
    expect(spec.setup?.plugins).toEqual(['/setup/yours', '/setup/project']);
    expect(spec.instructions).toBe('Use pnpm.');
    expect(spec.policy).toMatchObject({ surface: 'chat', attended: true });
    // The tools that reach GitHub are the judge's, so no allow rule approves them first.
    const judged = new Set(['push_branch', 'open_pull_request', 'merge_pull_request']);
    for (const name of Object.values(ChatToolName))
      expect(profile.allowedTools.includes(`mcp__10db__${name}`)).toBe(!judged.has(name));
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

  // Codex's web search follows the Web switch as a lane's does, and its chat is told only what it has. A Claude
  // chat's web is its hook's, so the switch doesn't move what it is told.
  it.each([
    { kind: AccountKind.ClaudeSubscription, web: true, says: true, mode: 'live' },
    { kind: AccountKind.ClaudeSubscription, web: false, says: true, mode: 'disabled' },
    { kind: AccountKind.CodexSignin, web: true, says: true, mode: 'live' },
    { kind: AccountKind.CodexSignin, web: false, says: false, mode: 'disabled' },
  ])(
    'on a $kind account with the Web switch $web the chat asks for web search $mode and says it searches: $says',
    async ({ kind, web, says, mode }) => {
      w = chatWorld({ prepare: prepared, judge: JudgeKind.Tendb });
      w.launchOn(kind);
      w.state.write((ctx) => {
        setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, web });
      });
      const chat = w.open();
      w.chat.send(chat.conversationId, {
        text: 'Why does login fail?',
        mentions: [],
        pictures: [],
      });
      await w.engine.settled(chat.conversationId);
      const spec = w.adapter.shapeSessions[0]?.spec;
      expect(spec?.webSearch).toBe(mode);
      const prompt = spec?.profile.systemPrompt ?? '';
      expect(prompt.includes('search the web')).toBe(says);
      expect(prompt.includes('no web search')).toBe(!says);
    },
  );

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
    expect(profile.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(profile.tools).not.toContain('Edit');
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

describe("a chat's background jobs", () => {
  it('marks what a session runs at its first command, once, and stops its jobs when the turn ends', async () => {
    jobs.marks = 0;
    jobs.ends = 0;
    const spec = await firstSpec(JudgeKind.Native);
    // The first turn has ended by now: a session stops what its commands left.
    await waitFor(() => jobs.ends === 1);
    expect(jobs.marks).toBe(0);
    spec.preToolUse({ toolName: 'Bash', input: { command: 'pnpm dev &' } });
    spec.preToolUse({ toolName: 'Bash', input: { command: 'ls' } });
    spec.preToolUse({ toolName: 'Read', input: { file_path: '/repo/a.ts' } });
    expect(jobs.marks).toBe(1);
  });

  it('stops the jobs of a session that held Your folder too, which stays warm', async () => {
    jobs.ends = 0;
    w = chatWorld({ prepare: prepared, judge: JudgeKind.Native });
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Fix login', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    await waitFor(() => (jobs.ends === 1 ? true : undefined));
    expect(w.engine.view(chat.conversationId).state).toBe('idle_warm');
  });
});

// The folder goes back only once the jobs a turn left have stopped: a lane that took it while they ran would find
// a writable process in its checkout.
describe("a chat's hold while its jobs stop", () => {
  const free = (): boolean => w.folderHold.reserveGit(w.project.id, 'probe').reserved;

  async function endedTurn(stopping: Promise<void>) {
    jobs.ends = 0;
    jobs.releases = 0;
    jobs.stopping = stopping;
    w = chatWorld({ prepare: prepared, judge: JudgeKind.Native });
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Fix login', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    await waitFor(() => (jobs.ends === 1 ? true : undefined));
    return chat;
  }
  afterEach(() => {
    jobs.stopping = null;
  });

  it('is kept until the jobs have stopped, then given back', async () => {
    let stopped: () => void = () => undefined;
    await endedTurn(
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
    );
    expect(free()).toBe(false);
    stopped();
    await waitFor(() => (free() ? true : undefined));
  });

  it("is kept by the chat's next turn, which cancels the pending release", async () => {
    let stopped: () => void = () => undefined;
    const chat = await endedTurn(
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
    );
    let finish: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          finish = r;
        });
        return { text: 'Done.' };
      };
    });
    w.chat.send(chat.conversationId, { text: 'and again', mentions: [], pictures: [] });
    await started;
    stopped();
    // Let the stop's continuation run: the second turn's hold must outlive it.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(free()).toBe(false);
    finish();
    await w.engine.settled(chat.conversationId);
  });

  it("is kept by the chat's next turn when the session was closed idle before the jobs stopped", async () => {
    let stopped: () => void = () => undefined;
    const chat = await endedTurn(
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
    );
    // A second state change outside a turn (the idle close) lands before the first stop settles.
    w.clock.advance(24 * 60 * 60 * 1000);
    await waitFor(() =>
      w.engine.view(chat.conversationId).state === 'idle_cold' ? true : undefined,
    );
    let finish: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          finish = r;
        });
        return { text: 'Done.' };
      };
    });
    w.chat.send(chat.conversationId, { text: 'and again', mentions: [], pictures: [] });
    await started;
    stopped();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(free()).toBe(false);
    finish();
    await w.engine.settled(chat.conversationId);
  });

  it('is given back after the warm session is closed when the jobs never stop', async () => {
    await endedTurn(new Promise<void>(() => undefined));
    expect(free()).toBe(false);
    w.clock.advance(JOBS_STOP_DEADLINE_MS);
    await waitFor(() => (free() ? true : undefined));
    expect(jobs.releases).toBe(1);
  });

  it('is given back after the warm session is closed when the jobs cannot be stopped', async () => {
    let failed: (error: Error) => void = () => undefined;
    await endedTurn(
      new Promise<void>((_resolve, reject) => {
        failed = reject;
      }),
    );
    expect(free()).toBe(false);
    expect(jobs.releases).toBe(0);
    failed(new Error('ps failed'));
    await waitFor(() => (free() ? true : undefined));
    expect(jobs.releases).toBe(1);
  });
});

describe("a chat's older session", () => {
  it('keeps no call of its own once a newer session of the chat holds Your folder', async () => {
    w = chatWorld({ prepare: prepared, judge: JudgeKind.Native });
    const chat = w.open();
    const edit = { toolName: 'Write', input: { file_path: '/repo/a.ts', content: 'x' } };
    /** Sends a message and runs `during` while its turn is in progress. */
    const turn = async (text: string, during: () => void) => {
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        w.adapter.shapeBehaviour = async () => {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
          return { text: 'Done.' };
        };
      });
      w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });
      await started;
      during();
      release();
      await w.engine.settled(chat.conversationId);
    };
    let first: ExploreSessionSpec | undefined;
    await turn('fix login', () => {
      first = w.adapter.shapeSessions[0]?.spec;
      expect(first?.preToolUse(edit)).toEqual({ decision: 'allow' });
    });
    // 10db's git work takes the folder, so the next turn reads only and opens a session of its own.
    const reservation = w.folderHold.reserveGit(w.project.id, 'cutting a branch');
    if (!reservation.reserved) throw new Error('the folder was not free');
    await turn('look again', () => undefined);
    w.folderHold.releaseGit(reservation.token);
    await turn('now fix it', () => {
      expect(w.adapter.shapeSessions).toHaveLength(3);
      // The chat holds the folder again, in its third session; the first one's late call is still refused.
      expect(w.adapter.shapeSessions[2]?.spec.preToolUse(edit)).toEqual({ decision: 'allow' });
      expect(first?.preToolUse(edit).decision).toBe('deny');
    });
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

  // The tools that send work out or merge are never settled by the fast path: 10db's judge's model reads each.
  it.each(['push_branch', 'open_pull_request', 'merge_pull_request'])(
    "asks 10db's model about %s, which the fast path never settles",
    async (name) => {
      const spec = await firstSpec(JudgeKind.Tendb, null, tendbAnswering('writes_live'));
      const judgeCall = spec.judgeCall;
      if (judgeCall === undefined) throw new Error('the chat has no session judge');
      const verdict = await judgeCall({
        toolName: `mcp__10db__${name}`,
        input: {},
        cwd: '/repo',
        toolUseId: 'toolu_1',
        signal: new AbortController().signal,
        hunk: null,
      });
      expect(verdict.decision).toBe('ask');
    },
  );

  it("says in the chat, once, that the judge didn't answer and the rules judge", async () => {
    w = chatWorld({
      prepare: prepared,
      judge: JudgeKind.Tendb,
      tendb: ({ store }) =>
        createJudge({
          state: createStateStore(store, createEventBus()),
          clock: new ManualClock(),
          fetch: () => Promise.resolve(new Response('down', { status: 500 })),
          readKey: () => Promise.resolve('router-key-0123'),
          decisionModelIds: () => new Set(['typesafe/jev-1.13']),
          off: false,
          logger: silentLogger,
        }),
    });
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Why does login fail?', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    const judgeCall = w.adapter.shapeSessions[0]?.spec.judgeCall;
    if (judgeCall === undefined) throw new Error('the chat has no session judge');
    const call = {
      toolName: 'Bash',
      input: { command: 'vercel deploy --prod' },
      cwd: '/repo',
      toolUseId: 'toolu_1',
      signal: new AbortController().signal,
      hunk: null,
    };
    await judgeCall(call);
    await judgeCall({ ...call, toolUseId: 'toolu_2' });
    const notices = listItems(w.store.db, chat.conversationId).filter(
      (item) => item.kind === ConversationItemKind.Notice,
    );
    expect(notices).toHaveLength(1);
    const texts = notices.map((item) => {
      const body = parseItemBody(item.kind, item.body);
      return 'text' in body ? body.text : '';
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("10db's judge didn't answer");
  });
});
