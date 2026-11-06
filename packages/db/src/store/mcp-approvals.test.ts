import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLatestApprovedMcpApproval, getMcpApproval, recordMcpApproval } from './mcp-approvals';
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
      hosts: ['registry.npmjs.org', '*.example.org'],
      sourceInboxId: null,
    };
    store.write((ctx) => recordMcpApproval(ctx, approval));
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_A)).toMatchObject({
      verdict: 'approved',
      variables: ['DOCS_TOKEN'],
      hosts: ['registry.npmjs.org', '*.example.org'],
    });
    // A changed config, another server name or another project has no verdict.
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_B)).toBeNull();
    expect(getMcpApproval(store.db, project.id, 'feed', HASH_A)).toBeNull();
    expect(getMcpApproval(store.db, other.id, 'docs', HASH_A)).toBeNull();
  });

  it("finds the server's latest approval whatever its config, and none for a denial", () => {
    const project = seedProject(store);
    const other = seedProject(store);
    const key = { projectId: project.id, serverName: 'docs', sourceInboxId: null };
    expect(getLatestApprovedMcpApproval(store.db, project.id, 'docs')).toBeNull();
    store.write((ctx) =>
      recordMcpApproval(ctx, {
        ...key,
        configHash: HASH_A,
        verdict: 'approved',
        variables: [],
        hosts: ['a.example.org'],
      }),
    );
    store.write((ctx) =>
      recordMcpApproval(ctx, {
        ...key,
        configHash: HASH_B,
        verdict: 'approved',
        variables: [],
        hosts: ['a.example.org', 'b.example.org'],
      }),
    );
    store.write((ctx) =>
      recordMcpApproval(ctx, {
        ...key,
        configHash: 'c'.repeat(64),
        verdict: 'denied',
        variables: [],
        hosts: [],
      }),
    );
    expect(getLatestApprovedMcpApproval(store.db, project.id, 'docs')).toMatchObject({
      configHash: HASH_B,
      hosts: ['a.example.org', 'b.example.org'],
    });
    expect(getLatestApprovedMcpApproval(store.db, project.id, 'feed')).toBeNull();
    expect(getLatestApprovedMcpApproval(store.db, other.id, 'docs')).toBeNull();
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
      recordMcpApproval(ctx, {
        ...key,
        verdict: 'approved',
        variables: ['DOCS_TOKEN'],
        hosts: ['registry.npmjs.org'],
      }),
    );
    store.write((ctx) =>
      recordMcpApproval(ctx, { ...key, verdict: 'denied', variables: [], hosts: [] }),
    );
    expect(getMcpApproval(store.db, project.id, 'docs', HASH_A)).toMatchObject({
      verdict: 'denied',
      variables: [],
      hosts: [],
    });
  });
});
