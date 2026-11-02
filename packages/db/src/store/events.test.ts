import { EventType } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorkstreamCommitShas } from './events';
import type { Store } from './store';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

describe('listWorkstreamCommitShas', () => {
  const record = (entityId: string, data: Record<string, string | boolean | string[]>) =>
    store.write((ctx) => {
      ctx.emit({ type: EventType.CommitRecorded, entityType: 'workstream', entityId, data });
    });

  it("lists the workstream's own recorded commits, oldest first, and no other's", () => {
    record('wst_a', { sha: '1'.repeat(40), paths: ['a'], alreadyCommitted: false });
    record('wst_b', { sha: '2'.repeat(40), paths: ['b'], alreadyCommitted: false });
    record('wst_a', { sha: '3'.repeat(40), paths: ['c'], alreadyCommitted: true });
    store.write((ctx) => {
      ctx.emit({
        type: EventType.EvidenceRecorded,
        entityType: 'workstream',
        entityId: 'wst_a',
        data: { sha: '4'.repeat(40) },
      });
    });
    expect(listWorkstreamCommitShas(store.db, 'wst_a')).toEqual(['1'.repeat(40), '3'.repeat(40)]);
    expect(listWorkstreamCommitShas(store.db, 'wst_none')).toEqual([]);
  });
});
