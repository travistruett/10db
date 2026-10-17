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
  envNames: [],
  headerNames: ['Authorization'],
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
        headerNames: [],
        variables: [],
        sensitive: [],
      }),
    );
    expect(card.body).toContain('Runs: npx -y "a b"');
    expect(card.body).toContain('Reads nothing from your environment.');
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
