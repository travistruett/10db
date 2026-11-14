import { ChatToolName, JudgeKind } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
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
): Promise<ExploreSessionSpec> {
  w = chatWorld({ prepare: prepared, judge });
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
    expect(spec.mcp.url).toBe('http://127.0.0.1:4317/mcp');
    expect(spec.setup?.plugins).toEqual(['/setup/yours', '/setup/project']);
    expect(spec.instructions).toBe('Use pnpm.');
    expect(spec.policy).toMatchObject({ surface: 'chat', attended: true });
    for (const name of Object.values(ChatToolName))
      expect(profile.allowedTools).toContain(`mcp__10db__${name}`);
  });

  it.each([
    { judge: JudgeKind.Native, web: 'allow' },
    { judge: JudgeKind.Tendb, web: 'deny' },
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

  // A chat attaches no hook judge, so on 10db's judge (Codex, a gateway) a command the rules would card is
  // carded: nothing else would judge it, and a Codex hook runs what it allows.
  it.each([JudgeKind.Tendb, JudgeKind.Rules])(
    'on a %s judge with no hook judge it asks the builder about a command that is not read-only',
    async (judge) => {
      const spec = await firstSpec(judge);
      expect(spec.judgeCall).toBeUndefined();
      expect(spec.preToolUse({ toolName: 'Bash', input: { command: 'make build' } }).decision).toBe(
        'ask',
      );
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
