import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, testPolicy } from '../../test/fixtures';
import { FakeSessionClashError } from './fake-session';
import {
  FakeAdapter,
  loadFakeScriptBook,
  type FakeScriptBook,
  type ExploreSessionSpec,
  type LaneProfile,
  type LaneSessionSpec,
  type SessionEvent,
  type ToolRequest,
} from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('fake');
});
afterEach(() => {
  dir.cleanup();
});

type LaneOverrides = Partial<Omit<LaneSessionSpec, 'profile'>> & {
  readonly profile?: Partial<Omit<LaneProfile, 'kind'>>;
};

function spec(overrides: LaneOverrides = {}): LaneSessionSpec {
  const { profile, ...core } = overrides;
  return {
    sessionId: mintId('Session'),
    policy: testPolicy(),
    cwd: dir.path,
    prompt: 'Task: Alpha\nDo it.',
    model: 'sonnet',
    effort: 'medium',
    resumeProviderSessionId: null,
    env: {},
    account: {
      accountId: mintId('Account'),
      label: 'Claude plan',
      kind: 'claude_subscription',
      identity: 'builder@example.com',
    },
    projectMcpServers: {},
    sandbox: null,
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', toolTimeoutMs: 1000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    ...core,
    profile: {
      kind: 'lane',
      workstreamId: mintId('Workstream'),
      sequence: 1,
      allowedTools: ['Write'],
      ...profile,
    },
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

describe('FakeAdapter', () => {
  it('emits started, the scripted events, then ended exactly once', async () => {
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'context', percentage: 40 }, { do: 'turn_complete' }]],
    });
    const events = await collect(adapter.open(spec()).events);
    expect(events.map((e) => e.type)).toEqual(['started', 'context', 'turn_complete', 'ended']);
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'completed', message: null });
  });

  it('picks the script for the session sequence', async () => {
    const book: FakeScriptBook = {
      Alpha: [[{ do: 'end' }], [{ do: 'activity', summary: 'second session' }]],
    };
    const adapter = new FakeAdapter(book);
    const events = await collect(adapter.open(spec({ profile: { sequence: 2 } })).events);
    expect(events).toContainEqual({ type: 'activity', kind: 'text', summary: 'second session' });
  });

  it('reports a scripted tool call as a running then a done tool call, with no activity', async () => {
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'a.ts', content: 'x' } }]],
    });
    const events = await collect(adapter.open(spec()).events);
    expect(events.filter((e) => e.type === 'activity')).toEqual([]);
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls).toMatchObject([
      { id: 'fake-tool-0', kind: 'edit', path: 'a.ts', change: 'add', status: 'running' },
      { id: 'fake-tool-0', kind: 'edit', path: 'a.ts', status: 'done', deniedBy: null },
    ]);
  });

  it('reports a call the guard denied as denied by 10db, with its reason', async () => {
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'Bash', input: { command: 'git push' } }]],
    });
    const events = await collect(
      adapter.open(spec({ preToolUse: () => ({ decision: 'deny', reason: 'pushes are 10db' }) }))
        .events,
    );
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls).toMatchObject([
      { kind: 'command', status: 'running' },
      { kind: 'command', status: 'denied', deniedBy: '10db', refusal: 'pushes are 10db' },
    ]);
  });

  it('streams what it says as two deltas and a message, offset by JS length', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'say', text: 'héllo 👋 world' }]] });
    const events = await collect(adapter.open(spec()).events);
    const said = events.filter((e) => e.type === 'text_delta' || e.type === 'message');
    expect(said).toEqual([
      { type: 'text_delta', itemId: 'fake-msg-1', offset: 0, text: 'héllo ' },
      { type: 'text_delta', itemId: 'fake-msg-1', offset: 6, text: '👋 world' },
      { type: 'message', itemId: 'fake-msg-1', text: 'héllo 👋 world' },
    ]);
  });

  it('streams its thinking, its plan, its commands and a scripted tool call as they are', async () => {
    const call = {
      kind: 'command',
      id: 'cmd_1',
      harnessTool: 'command',
      status: 'running',
      title: 'ls',
      startedAt: '2026-11-12T00:00:00.000Z',
      durationMs: null,
      parentId: null,
      refusal: null,
      deniedBy: null,
      limit: null,
      soft: null,
      command: 'ls',
      cwd: null,
      outputTail: '',
      outputBytes: 0,
      exitCode: null,
    } as const;
    const adapter = new FakeAdapter({
      Alpha: [
        [
          { do: 'think', text: 'hmm' },
          { do: 'plan', steps: [{ text: 'Read it', status: 'in_progress' }] },
          { do: 'commands', names: ['compact', 'review'] },
          { do: 'tool_call', call },
        ],
      ],
    });
    const events = await collect(adapter.open(spec()).events);
    expect(events.slice(1, -1)).toEqual([
      { type: 'reasoning_delta', itemId: 'fake-thought-1', offset: 0, text: 'hmm' },
      { type: 'plan_update', steps: [{ text: 'Read it', status: 'in_progress' }] },
      {
        type: 'commands',
        commands: [
          { name: 'compact', description: '/compact' },
          { name: 'review', description: '/review' },
        ],
      },
      { type: 'tool_call', call },
    ]);
  });

  it('crashes a session that has no script', async () => {
    const events = await collect(new FakeAdapter({}).open(spec()).events);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
  });

  it('applies an allowed Write and skips canUseTool for allow-listed tools', async () => {
    const canUseTool = vi.fn<LaneSessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'allow' }),
    );
    const adapter = new FakeAdapter({
      Alpha: [
        [{ do: 'tool', toolName: 'Write', input: { file_path: 'out.txt', content: 'hello' } }],
      ],
    });
    await collect(adapter.open(spec({ canUseTool })).events);
    expect(readFileSync(join(dir.path, 'out.txt'), 'utf8')).toBe('hello');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('records a guard denial without calling canUseTool or writing', async () => {
    const canUseTool = vi.fn<LaneSessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'allow' }),
    );
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'x.txt', content: 'x' } }]],
    });
    await collect(
      adapter.open(
        spec({ canUseTool, preToolUse: () => ({ decision: 'deny', reason: 'outside claims' }) }),
      ).events,
    );
    expect(canUseTool).not.toHaveBeenCalled();
    expect(adapter.observations).toContainEqual(
      expect.objectContaining({ kind: 'denied_by_guard', detail: { reason: 'outside claims' } }),
    );
  });

  it('sends a call the guard asks about to canUseTool, though an allow rule covers it', async () => {
    const canUseTool = vi.fn<LaneSessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'deny', message: 'carded' }),
    );
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'x.txt', content: 'x' } }]],
    });
    await collect(
      adapter.open(
        spec({
          canUseTool,
          profile: { allowedTools: ['Write'] },
          preToolUse: () => ({ decision: 'ask', reason: 'the broker must see it' }),
        }),
      ).events,
    );
    expect(canUseTool).toHaveBeenCalledOnce();
    expect(() => readFileSync(join(dir.path, 'x.txt'))).toThrow();
  });

  it('treats a throwing preToolUse as a denial', async () => {
    const canUseTool = vi.fn<LaneSessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'allow' }),
    );
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'x.txt', content: 'x' } }]],
    });
    const events = await collect(
      adapter.open(
        spec({
          canUseTool,
          preToolUse: () => {
            throw new Error('guard exploded');
          },
        }),
      ).events,
    );
    expect(canUseTool).not.toHaveBeenCalled();
    expect(adapter.observations).toContainEqual(
      expect.objectContaining({ kind: 'denied_by_guard' }),
    );
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'completed', message: null });
    expect(() => readFileSync(join(dir.path, 'x.txt'))).toThrow();
  });

  it('routes AskUserQuestion through canUseTool and records the answers', async () => {
    const canUseTool = vi.fn((req: ToolRequest) =>
      Promise.resolve({
        behavior: 'allow' as const,
        updatedInput: { ...req.input, answers: { 'Which?': 'A' } },
      }),
    );
    const adapter = new FakeAdapter({
      Alpha: [[{ do: 'tool', toolName: 'AskUserQuestion', input: { questions: [] } }]],
    });
    await collect(
      adapter.open(spec({ canUseTool, profile: { allowedTools: ['AskUserQuestion'] } })).events,
    );
    expect(canUseTool).toHaveBeenCalledOnce();
    expect(adapter.observations).toContainEqual(
      expect.objectContaining({
        kind: 'tool_allowed',
        detail: { toolName: 'AskUserQuestion', answers: { 'Which?': 'A' } },
      }),
    );
  });

  it('blocks on await_message until a message contains the expected text', async () => {
    const adapter = new FakeAdapter({
      Alpha: [
        [
          { do: 'await_message', contains: 'write_handoff' },
          { do: 'tool', toolName: 'Write', input: { file_path: 'after.txt', content: 'go' } },
        ],
      ],
    });
    const handle = adapter.open(spec());
    let ended = false;
    const done = collect(handle.events).then((events) => {
      ended = true;
      return events;
    });
    const file = join(dir.path, 'after.txt');

    handle.send('unrelated');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(existsSync(file)).toBe(false);
    expect(ended).toBe(false);

    handle.send('please call write_handoff now');
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(readFileSync(file, 'utf8')).toBe('go');
    expect((await done).at(-1)).toEqual({ type: 'ended', reason: 'completed', message: null });
  });

  it('ends with stopped when stopped during a hang', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'hang' }]] });
    const handle = adapter.open(spec());
    const done = collect(handle.events);
    await handle.stop();
    expect((await done).at(-1)).toEqual({ type: 'ended', reason: 'stopped', message: null });
  });

  it('records the prompt it was started with', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'end' }]] });
    await collect(adapter.open(spec({ resumeProviderSessionId: 'prov-1' })).events);
    expect(adapter.prompts[0]).toMatchObject({ title: 'Alpha', resume: 'prov-1' });
  });

  it('refuses before the prompt when the scripted account differs, and records no prompt', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
    adapter.seen = () => ({ email: 'other@example.com' });
    const events = await collect(adapter.open(spec()).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: 'identity_mismatch' },
    });
    expect(adapter.prompts).toEqual([]);
  });

  it('answers a probe with what it is told to report, and records it', async () => {
    const adapter = new FakeAdapter({});
    expect(
      await adapter.probeAccount({ kind: 'claude_subscription', cwd: '/d', env: {} }),
    ).toMatchObject({
      email: 'builder@example.com',
    });
    expect(adapter.probes).toEqual([{ kind: 'claude_subscription', cwd: '/d', env: {} }]);
  });
});

describe('one open handle per agent session', () => {
  const hanging = () => new FakeAdapter({ Alpha: [[{ do: 'hang' }]] });
  const exploreSpec = (resume: string | null): ExploreSessionSpec => ({
    ...spec({ resumeProviderSessionId: resume }),
    profile: {
      kind: 'explore',
      shapeId: mintId('Shape'),
      systemPrompt: 'You are Shape.',
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      agents: {},
    },
  });

  it('refuses a second lane that resumes the agent session a lane holds', () => {
    const adapter = hanging();
    adapter.open(spec({ resumeProviderSessionId: 'p1' }));
    expect(() => adapter.open(spec({ resumeProviderSessionId: 'p1' }))).toThrow(
      FakeSessionClashError,
    );
    expect(() => adapter.open(spec({ resumeProviderSessionId: 'p1' }))).toThrow('p1');
    expect(adapter.prompts).toHaveLength(1);
  });

  it('opens a lane on an agent session whose earlier handle has ended', async () => {
    const adapter = hanging();
    const first = adapter.open(spec({ resumeProviderSessionId: 'p1' }));
    await first.stop();
    await collect(first.events);
    expect(() => adapter.open(spec({ resumeProviderSessionId: 'p1' }))).not.toThrow();
  });

  it("streams an explore session's reply as two deltas and a message before its turn ends", async () => {
    const adapter = new FakeAdapter({});
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
    const handle = adapter.open(exploreSpec(null));
    const events: SessionEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_complete') void handle.stop();
    }
    expect(
      events
        .filter((e) => ['text_delta', 'message', 'turn_complete'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['text_delta', 'text_delta', 'message', 'turn_complete']);
    expect(events).toContainEqual({ type: 'message', itemId: 'fake-msg-1', text: 'Understood.' });
  });

  it('refuses an explore session on the agent session a lane holds: the key is the agent session', () => {
    const adapter = hanging();
    adapter.open(spec({ resumeProviderSessionId: 'p1' }));
    expect(() => adapter.open(exploreSpec('p1'))).toThrow(FakeSessionClashError);
  });

  it('opens two fresh lanes, each under its own minted id', () => {
    const adapter = hanging();
    expect(() => {
      adapter.open(spec());
      adapter.open(spec());
    }).not.toThrow();
  });

  it('opens a lane on an agent session whose earlier start was refused for its account', async () => {
    const adapter = hanging();
    adapter.seen = () => ({ email: 'other@example.com' });
    const refused = adapter.open(spec({ resumeProviderSessionId: 'p1' }));
    expect((await collect(refused.events)).at(-1)).toMatchObject({ reason: 'account_refused' });
    adapter.seen = () => ({});
    expect(() => adapter.open(spec({ resumeProviderSessionId: 'p1' }))).not.toThrow();
  });
});

describe('loadFakeScriptBook', () => {
  it('reads a script book from disk', () => {
    const file = join(dir.path, 'book.json');
    writeFileSync(file, JSON.stringify({ Alpha: [[{ do: 'turn_complete' }]] }));
    expect(loadFakeScriptBook(file)).toEqual({ Alpha: [[{ do: 'turn_complete' }]] });
  });

  it('rejects a file whose steps are not valid', () => {
    const file = join(dir.path, 'bad.json');
    writeFileSync(file, JSON.stringify({ Alpha: [[{ do: 'explode' }]] }));
    expect(() => loadFakeScriptBook(file)).toThrow();
  });
});
