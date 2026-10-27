import { InvalidError, MCP_APPROVAL_DETAIL, type McpServerReview } from '@10db/contracts';
import { createTestStore, getMcpApproval, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { requestMcpApproval } from './mcp-approval';
import { createInboxService, type InboxService } from './service';

let close: () => void;
let store: Store;
let inbox: InboxService;
beforeEach(() => {
  ({ store, close } = createTestStore());
  inbox = createInboxService({
    state: createStateStore(store, createEventBus()),
    onParkedAnswer: () => undefined,
  });
});
afterEach(() => {
  close();
});

const review = (overrides: Partial<McpServerReview> = {}): McpServerReview => ({
  name: 'docs',
  configHash: 'c'.repeat(64),
  transport: 'http',
  command: null,
  args: [],
  url: 'https://docs.example/mcp',
  env: [],
  headers: [{ name: 'Authorization', value: 'Bearer ${DOCS_TOKEN}' }],
  variables: ['DOCS_TOKEN'],
  sensitive: ['DOCS_TOKEN'],
  ...overrides,
});

describe('MCP approval cards', () => {
  it('shows exactly what would be contacted and which variables it reads, as a project-wide card', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, review());
    expect(card).toMatchObject({
      kind: 'flag',
      state: 'OPEN',
      targets: [],
      title: 'Run the repo\'s MCP server "docs"?',
    });
    expect(card.options.map((o) => o.label)).toEqual(['approve', 'deny']);
    expect(card.body).toContain('Connects to: https://docs.example/mcp');
    expect(card.body).toContain('Reads from your environment: DOCS_TOKEN');
    expect(card.body).toContain('These look like credentials: DOCS_TOKEN');
    expect(card.detail?.[MCP_APPROVAL_DETAIL]).toEqual(review());
  });

  it('quotes a stdio argument only when it needs it', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(
      inbox,
      project.id,
      review({
        name: 'tool',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'a b'],
        url: null,
        headers: [],
        variables: [],
        sensitive: [],
      }),
    );
    expect(card.body).toContain('Runs: npx -y "a b"');
    expect(card.body).toContain('Reads nothing from your environment.');
  });

  it('lists the headers it sends, with their unexpanded values', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, review());
    expect(card.body).toContain('Sends headers: Authorization="Bearer ${DOCS_TOKEN}"');
  });

  it('shows the full launch line, and says when the env block replaces PATH or HOME', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(
      inbox,
      project.id,
      review({
        name: 'tool',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mantine/mcp-server@9.7.2'],
        url: null,
        headers: [],
        env: [
          { name: 'NODE_OPTIONS', value: '--require ./.tools/x.js' },
          { name: 'PATH', value: './.tools:/usr/bin:/bin' },
        ],
        variables: [],
        sensitive: [],
      }),
    );
    expect(card.body).toContain(
      'Runs: NODE_OPTIONS="--require ./.tools/x.js" PATH=./.tools:/usr/bin:/bin npx -y @mantine/mcp-server@9.7.2',
    );
    expect(card.body).toContain(
      'Sets: NODE_OPTIONS="--require ./.tools/x.js", PATH=./.tools:/usr/bin:/bin',
    );
    expect(card.body).toContain('Its env block replaces PATH');
    expect(card.body).not.toContain('It gets the variables lane commands get');
  });

  it('says what a stdio server gets and that it runs in the sandbox, with no network, when its env block touches neither PATH nor HOME', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(
      inbox,
      project.id,
      review({
        transport: 'stdio',
        command: 'npx',
        url: null,
        headers: [],
        env: [{ name: 'LEVEL', value: 'info' }],
        variables: [],
        sensitive: [],
      }),
    );
    expect(card.body).toContain('Sets: LEVEL=info');
    expect(card.body).toContain(
      'It gets the variables lane commands get, with no credentials, plus what its env block sets.',
    );
    expect(card.body).toContain(
      'It runs in a sandbox: it reads what lane commands read, writes only its own temp dir and reaches no host',
    );
    expect(card.body).toContain("such as npx -y for a package the repo doesn't install");
    expect(card.body).not.toContain('replaces');
  });

  // The card must say what will run, whatever text the repo supplies.
  it.each([
    [
      'a newline in the name',
      review({ name: 'docs"\nConnects to: https://safe.example' }),
      'docs"\nConnects',
      '\\u{a}',
    ],
    [
      'a bidi override in an argument',
      review({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'safe\u202Egnp.js'],
        url: null,
        headers: [],
        variables: [],
        sensitive: [],
      }),
      '\u202E',
      '"safe\\u{202e}gnp.js"',
    ],
    [
      'a zero-width space in the URL',
      review({ url: 'https://docs.example\u200B.evil/mcp' }),
      '\u200B',
      '\\u{200b}',
    ],
    [
      'U+2028 in an env value',
      review({
        transport: 'stdio',
        command: 'npx',
        args: [],
        url: null,
        headers: [],
        env: [{ name: 'A', value: 'x\u2028Connects to: y' }],
        variables: [],
        sensitive: [],
      }),
      '\u2028',
      'A="x\\u{2028}Connects to: y"',
    ],
    [
      'a control character in a header name',
      review({ headers: [{ name: 'X\u0085Y', value: 'v' }] }),
      '\u0085',
      '\\u{85}',
    ],
    [
      'a zero-width joiner in a command',
      review({
        transport: 'stdio',
        command: 'np\u200Dx',
        args: [],
        url: null,
        headers: [],
        variables: [],
        sensitive: [],
      }),
      '\u200D',
      '\\u{200d}',
    ],
  ])('renders %s as visible escapes', (_name, hostile, raw, escaped) => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, hostile);
    expect(card.body).not.toContain(raw);
    expect(card.title).not.toContain(raw);
    expect(card.body + card.title).toContain(escaped);
    // Repo text never adds a line: only the card's own lines separate.
    expect(card.body.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('folds a repeated request for the same config into the open card', () => {
    const project = seedProject(store);
    const first = requestMcpApproval(inbox, project.id, review());
    expect(requestMcpApproval(inbox, project.id, review()).id).toBe(first.id);
    expect(
      requestMcpApproval(inbox, project.id, review({ configHash: 'd'.repeat(64) })).id,
    ).not.toBe(first.id);
  });

  it("records approval with the card's variables, in the answer's transaction", () => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, review());
    expect(inbox.answer(card.id, { choice: 'approve' })).toMatchObject({ state: 'RESOLVED' });
    expect(getMcpApproval(store.db, project.id, 'docs', 'c'.repeat(64))).toMatchObject({
      verdict: 'approved',
      variables: ['DOCS_TOKEN'],
      sourceInboxId: card.id,
    });
  });

  it('records a denial with no variables', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, review());
    inbox.answer(card.id, { choice: 'deny' });
    expect(getMcpApproval(store.db, project.id, 'docs', 'c'.repeat(64))).toMatchObject({
      verdict: 'denied',
      variables: [],
    });
  });

  it('accepts only approve or deny, and an ordinary flag records nothing', () => {
    const project = seedProject(store);
    const card = requestMcpApproval(inbox, project.id, review());
    expect(() => inbox.answer(card.id, { choice: 'dismissed' })).toThrow(InvalidError);
    const plain = inbox.flag({
      projectId: project.id,
      workstreamId: null,
      title: 'Watcher',
      body: 'stray write',
    });
    inbox.answer(plain.id, { choice: 'approve' });
    expect(getMcpApproval(store.db, project.id, 'docs', 'c'.repeat(64))).toBeNull();
  });
});
