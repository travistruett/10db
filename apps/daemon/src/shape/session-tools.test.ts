import { ShapeMessageKind } from '@10db/contracts';
import { getSession, insertInboxItem, listShapeMessages } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { autoModeRules, type LaneSandboxSpec } from '../sandbox';
import type { SessionEvent, ToolRequest } from '../sessions';
import { must } from './conversation-fixture';
import type { ShapePrepareInput, ShapePrepared } from './service';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.2: a conversation's session is prepared with its read-only sandbox, the project's
// approved MCP servers and the lanes' permission broker, and what it was prepared with goes when the
// session does.

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
  env: { CLAUDE_CODE_TMPDIR: '/t/x' },
  disallowedTools: [],
  autoMode: autoModeRules(null),
  askRules: [],
};

let f: ServiceFixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function preparing(credentialsExpireAt: string | null = null) {
  const seen: ShapePrepareInput[] = [];
  const asked: ToolRequest[] = [];
  const tracked: number[] = [];
  let disposed = 0;
  const prepare = (input: ShapePrepareInput): Promise<ShapePrepared> => {
    seen.push(input);
    return Promise.resolve({
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
      note: 'Note from 10db: billing is waiting for your approval.',
      credentialsExpireAt,
      canUseTool: (req) => {
        asked.push(req);
        return Promise.resolve({ behavior: 'deny', message: 'the builder said no' });
      },
      trackProcesses: (pid) => {
        tracked.push(pid);
      },
      // Removing a sandbox takes a while: its processes are given time to end.
      release: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        disposed += 1;
      },
    });
  };
  return { prepare, seen, asked, tracked, disposed: () => disposed };
}

describe('a conversation’s prepared session', () => {
  it('runs in its sandbox with the project’s servers and the broker, and is told what was left out', async () => {
    const p = preparing();
    f = createServiceFixture({ prepare: p.prepare });
    f.service.send(f.c.shape.id, 'Where does billing live?');
    await tick();
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    expect(spec.sandbox).toBe(SANDBOX);
    expect(Object.keys(spec.projectMcpServers)).toEqual(['docs']);
    expect(spec.tools).toContain('Bash');
    expect(spec.disallowedTools).not.toContain('Bash');
    expect(spec.agents['code-researcher']?.tools).toContain('Bash');
    expect(spec.prompt.startsWith('Note from 10db: billing is waiting for your approval.')).toBe(
      true,
    );
    expect(p.seen.map((i) => [i.shapeId, i.sessionId, i.projectId])).toEqual([
      [f.c.shape.id, spec.sessionId, f.c.project.id],
    ]);
    const decision = await spec.canUseTool({
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      toolUseId: 't1',
      escalated: false,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ behavior: 'deny', message: 'the builder said no' });
    expect(p.asked.map((r) => r.toolName)).toEqual(['Bash']);
  });

  it('shows each command and project tool call, who made it, and a card it waits on', async () => {
    const p = preparing();
    f = createServiceFixture({ prepare: p.prepare });
    f.service.send(f.c.shape.id, 'Look at the git history.');
    await tick();
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    expect(spec.preToolUse({ toolName: 'Bash', input: { command: 'git log -3' } }).decision).toBe(
      'allow',
    );
    expect(
      spec.preToolUse({
        toolName: 'Bash',
        input: { command: 'pnpm test' },
        agentId: 'a1',
        agentType: 'code-researcher',
      }).decision,
    ).toBe('ask');
    expect(spec.preToolUse({ toolName: 'mcp__docs__search', input: { q: 'x' } }).decision).toBe(
      'ask',
    );
    const fixture = f;
    const card = fixture.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: fixture.c.project.id,
        kind: 'permission',
        title: 'Allow Bash?',
        body: 'pnpm test',
        options: [],
        recommendation: null,
        category: 'environment',
        urgency: 'normal',
        detail: null,
        foldKey: 'k',
        targets: [],
      }),
    );
    must(p.seen[0], 'prepared').observer.onWaitStart(card);
    const lines = listShapeMessages(f.c.store.db, f.c.shape.id)
      .filter((m) => m.kind === ShapeMessageKind.Tool)
      .map((m) => m.body);
    expect(lines).toEqual([
      'Bash · git log -3',
      'code-researcher · Bash · pnpm test',
      'mcp__docs__search · {"q":"x"}',
      'Allow Bash? · waiting for your answer in the Inbox',
    ]);
  });

  it('watches what runs under the session’s own Claude Code process, and stops it as the session ends', async () => {
    const p = preparing();
    f = createServiceFixture({ prepare: p.prepare });
    const fake = f.adapter;
    const startShape = fake.startShape.bind(fake);
    async function* withPid(events: AsyncIterable<SessionEvent>): AsyncIterable<SessionEvent> {
      for await (const event of events)
        yield event.type === 'started' ? { ...event, pid: 4242 } : event;
    }
    fake.startShape = (spec) => {
      const handle = startShape(spec);
      return { ...handle, events: withPid(handle.events) };
    };
    f.service.send(f.c.shape.id, 'Hello');
    await f.service.settled(f.c.shape.id);
    expect(p.tracked).toEqual([4242]);
    expect(p.disposed()).toBe(0);
    await f.service.close();
    expect(p.disposed()).toBe(1);
  });

  it.each([
    ['credentials about to expire', '2000-01-01T00:00:00Z', 2],
    ['no AWS credentials', null, 1],
  ] as const)(
    'moves a conversation with %s to a fresh session at its next turn: %s',
    async (_name, expiresAt, sessions) => {
      const p = preparing(expiresAt);
      f = createServiceFixture({ prepare: p.prepare });
      f.service.send(f.c.shape.id, 'First');
      await f.service.settled(f.c.shape.id);
      f.service.send(f.c.shape.id, 'Second');
      await f.service.settled(f.c.shape.id);
      expect(f.adapter.shapeSessions).toHaveLength(sessions);
      // The fresh one resumes the conversation, and its servers get new credentials.
      if (sessions === 2)
        expect(f.adapter.shapeSessions[1]?.spec.resumeProviderSessionId).toBe('fake-shape-1');
      expect(p.seen).toHaveLength(sessions);
    },
  );

  it('withdraws its cards and removes its sandbox when the session ends', async () => {
    const p = preparing();
    f = createServiceFixture({ prepare: p.prepare });
    f.service.send(f.c.shape.id, 'Hello');
    await f.service.settled(f.c.shape.id);
    const input = must(p.seen[0], 'prepared');
    expect(input.signal.aborted).toBe(false);
    await f.service.close();
    expect(input.signal.aborted).toBe(true);
    expect(p.disposed()).toBe(1);
  });

  it('starts no session, and removes what it prepared, when the service closes during the preparation', async () => {
    const p = preparing();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f = createServiceFixture({
      prepare: async (input) => {
        const prepared = await p.prepare(input);
        await held;
        return prepared;
      },
    });
    f.service.send(f.c.shape.id, 'Hello');
    await tick();
    const closing = f.service.close();
    release();
    await closing;
    await tick();
    expect(f.adapter.shapeSessions).toEqual([]);
    expect(p.disposed()).toBe(1);
    const input = must(p.seen[0], 'prepared');
    expect(input.signal.aborted).toBe(true);
    expect(getSession(f.c.store.db, input.sessionId).exitReason).toBe('start_failed');
  });

  it('starts no session when the builder presses Stop while it is being prepared', async () => {
    const p = preparing();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f = createServiceFixture({
      prepare: async (input) => {
        const prepared = await p.prepare(input);
        await held;
        return prepared;
      },
    });
    f.service.send(f.c.shape.id, 'Hello');
    await tick();
    await f.service.stop(f.c.shape.id);
    release();
    await f.service.settled(f.c.shape.id);
    expect(f.adapter.shapeSessions).toEqual([]);
    expect(p.disposed()).toBe(1);
    expect(getSession(f.c.store.db, must(p.seen[0], 'prepared').sessionId).exitReason).toBe(
      'start_failed',
    );
  });

  it('ends the session row and says why when the session cannot be prepared', async () => {
    f = createServiceFixture({
      prepare: () => Promise.reject(new Error('the sandbox could not be built')),
    });
    f.service.send(f.c.shape.id, 'Hello');
    await f.service.settled(f.c.shape.id);
    expect(f.adapter.shapeSessions).toEqual([]);
    const notices = listShapeMessages(f.c.store.db, f.c.shape.id)
      .filter((m) => m.kind === ShapeMessageKind.Notice)
      .map((m) => m.body);
    expect(notices).toEqual(['Claude could not start: the sandbox could not be built']);
  });

  it('runs no command and offers no project tool when nothing is prepared', async () => {
    f = createServiceFixture();
    f.service.send(f.c.shape.id, 'Hello');
    await tick();
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    expect(spec.sandbox).toBeNull();
    expect(spec.projectMcpServers).toEqual({});
    expect(spec.tools).not.toContain('Bash');
    expect(spec.preToolUse({ toolName: 'Bash', input: { command: 'ls' } }).decision).toBe('deny');
    expect(
      (
        await spec.canUseTool({
          toolName: 'Bash',
          input: {},
          toolUseId: 't',
          escalated: false,
          signal: new AbortController().signal,
        })
      ).behavior,
    ).toBe('deny');
    expect(getSession(f.c.store.db, spec.sessionId).shapeId).toBe(f.c.shape.id);
  });
});
