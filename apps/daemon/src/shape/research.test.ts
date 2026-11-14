import { mintId, ToolCallView, type ShapeId } from '@10db/contracts';
import { listItems, shapeConversation } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter, type FakeShapeTurn } from '../sessions';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import { createShapeService, type ShapeService } from './service';
import { SHAPE_AGENT_MODELS } from './confinement';

// Shape spec §5.2: the researcher reaches the web, and every search, fetch and refusal is in the
// conversation as the call the session reported: done, or denied by 10db with the guard's reason.

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

/** The calls the session reported, as stored: the adapter's own, not Plan's lines. */
const calls = (): ToolCallView[] =>
  listItems(c.store.db, shapeConversation(c.store.db, shapeId).id)
    .filter((i) => i.kind === 'tool_call')
    .map((i) => ToolCallView.parse(i.body))
    .filter((call) => call.harnessTool !== '10db.plan');

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
  it('stores the call that handed the researcher its question, then each search and fetch under it', async () => {
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
    const [agent, search, fetch] = calls();
    expect(agent).toMatchObject({
      kind: 'subagent',
      status: 'done',
      promptPreview: 'How does Vega-Lite order ties?',
    });
    expect(search).toMatchObject({
      kind: 'web',
      status: 'done',
      query: 'vega-lite stack order ties',
      parentId: agent?.id,
    });
    expect(fetch).toMatchObject({
      kind: 'web',
      status: 'done',
      url: 'https://vega.github.io/vega-lite/docs/stack.html',
      parentId: agent?.id,
    });
  });

  it.each([
    ['the main session', {}],
    ['the scope reviewer', { agentId: 'a', agentType: 'scope' }],
    ['the engineering reviewer', { agentId: 'a', agentType: 'engineering' }],
    ['the rehearsal reviewer', { agentId: 'a', agentType: 'rehearsal' }],
  ])('refuses a search and a fetch from %s, each a call 10db denied', async (_who, who) => {
    await turnWith([
      { toolName: 'WebSearch', input: { query: 'x' }, ...who },
      { toolName: 'WebFetch', input: { url: 'https://example.com/' }, ...who },
    ]);
    expect(calls().map((call) => [call.status, call.deniedBy, call.refusal !== null])).toEqual([
      ['denied', '10db', true],
      ['denied', '10db', true],
    ]);
  });

  it('refuses the researcher’s Read of the checkout and of the conversation’s files, each a call 10db denied', async () => {
    await turnWith([
      { toolName: 'Read', input: { file_path: '/repo/src/a.ts' }, ...RESEARCHER },
      { toolName: 'Read', input: { file_path: '/files/brief.md' }, ...RESEARCHER },
    ]);
    expect(
      calls().map((call) => [
        call.status,
        call.deniedBy,
        call.refusal?.startsWith('The researcher reads no files'),
      ]),
    ).toEqual([
      ['denied', '10db', true],
      ['denied', '10db', true],
    ]);
  });

  it('stores a refused fetch as a denied call and not as a fetch', async () => {
    await turnWith([
      { toolName: 'WebFetch', input: { url: 'https://127.0.0.1:4317/mcp' }, ...RESEARCHER },
    ]);
    expect(calls().map((call) => [call.kind, call.status, call.deniedBy])).toEqual([
      ['web', 'denied', '10db'],
    ]);
  });

  it('stores a refused Agent call once, denied', async () => {
    await turnWith([{ toolName: 'Agent', input: { subagent_type: 'researcher', prompt: ' ' } }]);
    expect(calls().map((call) => [call.kind, call.status, call.deniedBy])).toEqual([
      ['subagent', 'denied', '10db'],
    ]);
  });
});
