import { mintId, ShapeMessageAuthor, ShapeMessageKind, type ShapeId } from '@10db/contracts';
import { listShapeMessages } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter, type FakeShapeTurn } from '../sessions';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import { createShapeService, type ShapeService } from './service';
import { SHAPE_AGENT_MODELS } from './confinement';

// Shape spec §5.2: the researcher reaches the web, and every search, fetch and refusal shows in the
// conversation as a dimmed line (a Tool message from Claude).

let c: ConversationFixture;
let adapter: FakeAdapter;
let service: ShapeService;
let shapeId: ShapeId;
beforeEach(() => {
  c = seedConversation();
  adapter = new FakeAdapter({});
  shapeId = c.shape.id;
  service = createShapeService({
    state: createStateStore(c.store, createEventBus()),
    adapter,
    joiningProblem: () => null,
    clock: new ManualClock(),
    filesDir: '/files',
    log: silentLogger,
    mcp: { url: 'http://127.0.0.1:4317/mcp', toolTimeoutMs: 60_000 },
    brainstormRefusal: () => null,
    launch: () => ({
      cwd: '/repo',
      model: 'claude-opus-5-5',
      modelId: 'claude-opus-5-5',
      effort: 'high',
      agentModels: SHAPE_AGENT_MODELS,
      env: {},
      account: {
        accountId: mintId('Account'),
        label: 'Claude plan',
        kind: 'claude_subscription',
        identity: null,
      },
      access: {
        checkout: '/repo',
        home: '/home',
        protectedReads: [],
        filesDir: '/files',
        sandboxRoots: ['/tmp/10db'],
      },
    }),
  });
});
afterEach(async () => {
  await service.close();
  c.close();
});

const dimmed = (): string[] =>
  listShapeMessages(c.store.db, shapeId)
    .filter((m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Tool)
    .map((m) => m.body);

/** Runs one turn in which the model makes these calls through the hook, as Claude Code would. */
async function turnWith(
  calls: readonly {
    toolName: string;
    input: unknown;
    agentId?: string;
    agentType?: string;
  }[],
): Promise<void> {
  adapter.shapeBehaviour = (turn: FakeShapeTurn) => {
    for (const call of calls) turn.guard(call);
    return Promise.resolve({ text: 'Done.' });
  };
  service.send(shapeId, 'Look up how Vega-Lite orders ties.');
  await service.settled(shapeId);
}

const RESEARCHER = { agentId: 'agent-1', agentType: 'researcher' } as const;

describe('a research turn', () => {
  it('shows the question the session handed the researcher, each search and each fetch', async () => {
    await turnWith([
      {
        toolName: 'Agent',
        input: { subagent_type: 'researcher', prompt: 'How does Vega-Lite order ties?' },
      },
      { toolName: 'WebSearch', input: { query: 'vega-lite stack order ties' }, ...RESEARCHER },
      {
        toolName: 'WebFetch',
        input: { url: 'https://vega.github.io/vega-lite/docs/stack.html', prompt: 'ties' },
        ...RESEARCHER,
      },
    ]);
    expect(dimmed()).toEqual([
      'researcher · asked · How does Vega-Lite order ties?',
      'WebSearch · vega-lite stack order ties',
      'WebFetch · https://vega.github.io/vega-lite/docs/stack.html',
    ]);
  });

  it.each([
    ['the main session', {}],
    ['the scope reviewer', { agentId: 'a', agentType: 'scope' }],
    ['the engineering reviewer', { agentId: 'a', agentType: 'engineering' }],
    ['the rehearsal reviewer', { agentId: 'a', agentType: 'rehearsal' }],
  ])('refuses a search and a fetch from %s, with a dimmed line each', async (_who, who) => {
    await turnWith([
      { toolName: 'WebSearch', input: { query: 'x' }, ...who },
      { toolName: 'WebFetch', input: { url: 'https://example.com/' }, ...who },
    ]);
    const lines = dimmed();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^WebSearch · refused · /);
    expect(lines[1]).toMatch(/^WebFetch · refused · /);
  });

  it('refuses the researcher’s Read of the checkout and of the conversation’s files, with a dimmed line each', async () => {
    await turnWith([
      { toolName: 'Read', input: { file_path: '/repo/src/a.ts' }, ...RESEARCHER },
      { toolName: 'Read', input: { file_path: '/files/brief.md' }, ...RESEARCHER },
    ]);
    expect(dimmed()).toEqual([
      expect.stringMatching(/^Read · refused · The researcher reads no files/),
      expect.stringMatching(/^Read · refused · The researcher reads no files/),
    ]);
  });

  it('shows a refused fetch as a refusal and not as a fetch', async () => {
    await turnWith([
      { toolName: 'WebFetch', input: { url: 'https://127.0.0.1:4317/mcp' }, ...RESEARCHER },
    ]);
    expect(dimmed()).toEqual([expect.stringMatching(/^WebFetch · refused · /)]);
  });

  it('does not repeat the question of an Agent call it refused', async () => {
    await turnWith([{ toolName: 'Agent', input: { subagent_type: 'researcher', prompt: ' ' } }]);
    expect(dimmed()).toEqual([expect.stringMatching(/^Agent · refused · /)]);
  });
});
