import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMcpApproval, recordMcpApproval } from './mcp-approvals';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('MCP server approvals', () => {
  it('keys a verdict on project, server name and config hash', () => {
    const project = seedProject(store);
    const other = seedProject(store);
    const approval = {
      projectId: project.id,
      serverName: 'docs',
      configHash: HASH_A,
      verdict: 'approved' as const,
      variables: ['DOCS_TOKEN'],
      sourceInboxId: null,
    };
    store.write((ctx) => recordMcpApproval(ctx, approval));
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_A)).toMatchObject({
      verdict: 'approved',
      variables: ['DOCS_TOKEN'],
    });
    // A changed config, another server name or another project has no verdict.
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_B)).toBeNull();
    expect(getMcpApproval(store.db, project.id, 'feed', HASH_A)).toBeNull();
    expect(getMcpApproval(store.db, other.id, 'docs', HASH_A)).toBeNull();
  });

  it('lets a later answer for the same config replace the earlier one', () => {
    const project = seedProject(store);
    const key = {
      projectId: project.id,
      serverName: 'docs',
      configHash: HASH_A,
      sourceInboxId: null,
    };
    store.write((ctx) =>
      recordMcpApproval(ctx, { ...key, verdict: 'approved', variables: ['DOCS_TOKEN'] }),
    );
    store.write((ctx) => recordMcpApproval(ctx, { ...key, verdict: 'denied', variables: [] }));
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_A)).toMatchObject({
      verdict: 'denied',
      variables: [],
    });
  });
});
