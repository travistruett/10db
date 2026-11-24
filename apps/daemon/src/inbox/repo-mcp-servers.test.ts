import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError } from '@10db/contracts';
import { createTestStore, getInboxItem, getMcpApproval, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { requestMcpApproval } from './mcp-approval';
import { createRepoMcpServers } from './repo-mcp-servers';
import { createInboxService, type InboxService } from './service';

let close: () => void;
let store: Store;
let inbox: InboxService;
let repo: string;
beforeEach(() => {
  ({ store, close } = createTestStore());
  inbox = createInboxService({
    state: createStateStore(store, createEventBus()),
    onParkedAnswer: () => undefined,
  });
  repo = mkdtempSync(join(tmpdir(), 'repo-mcp-'));
  writeFileSync(
    join(repo, '.mcp.json'),
    JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }),
  );
});
afterEach(() => {
  close();
  rmSync(repo, { recursive: true, force: true });
});

describe('repo MCP servers on Settings', () => {
  it('approves the config the page showed, closes its open card, and refuses a stale one', () => {
    const project = seedProject(store, { repoPath: repo });
    const servers = createRepoMcpServers({
      state: createStateStore(store, createEventBus()),
      inbox,
    });
    const [listed] = servers.list(project.id).servers;
    if (listed === undefined) throw new Error('the fixture lists one server');
    // Listing raises nothing and says the verdict is pending.
    expect(listed).toMatchObject({ verdict: 'pending', inboxId: null });
    const card = requestMcpApproval(inbox, project.id, listed);
    expect(servers.list(project.id).servers[0]?.inboxId).toBe(card.id);

    expect(() =>
      servers.set(project.id, 'docs', { configHash: 'f'.repeat(64), verdict: 'approved' }),
    ).toThrow(ConflictError);
    expect(getMcpApproval(store.db, project.id, 'docs', listed.configHash)).toBeNull();
    expect(getInboxItem(store.db, card.id).state).toBe('OPEN');

    const after = servers.set(project.id, 'docs', {
      configHash: listed.configHash,
      verdict: 'approved',
    });
    expect(after.servers[0]).toMatchObject({ verdict: 'approved', inboxId: null });
    expect(getMcpApproval(store.db, project.id, 'docs', listed.configHash)).toMatchObject({
      verdict: 'approved',
      sourceInboxId: card.id,
    });
    expect(getInboxItem(store.db, card.id).state).not.toBe('OPEN');
  });
});
