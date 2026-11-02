import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type DecisionId,
  type ProjectDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  getDecision,
  insertDecision,
  insertSource,
  listRecentDecisions,
  searchDecisions,
  seedProject,
  withdrawDecision,
  type Store,
} from './index';

// Shape spec §11 (Withdraw Decision…), to M3's plan (docs/superpowers/plans/2026-10-22-10db-11-m3-knowledge.md
// K1, K3): a withdrawn tombstone with a required reason, and only the head of a supersede chain withdrawn.

let store: Store;
let close: () => void;
let project: ProjectDto;
const AT = new Date('2026-11-02T12:00:00.000Z');
beforeEach(() => {
  ({ store, close } = createTestStore(() => AT));
  project = seedProject(store);
});
afterEach(() => {
  close();
});

function decide(choice: string, supersedesId: DecisionId | null = null): DecisionId {
  return store.write((ctx) =>
    insertDecision(ctx, {
      projectId: project.id,
      question: 'Which queue library?',
      choice,
      rationale: 'It fits the stack',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId: insertSource(ctx, 'builder', {}),
      supersedesId,
    }),
  ).value;
}

const withdraw = (id: DecisionId, reason = 'We never adopted it') =>
  store.write((ctx) => {
    withdrawDecision(ctx, id, { by: 'me', reason });
  });

const searched = () => searchDecisions(store.db, project.id, 'queue', 10).map((hit) => hit.choice);

describe('withdrawDecision', () => {
  it('keeps the row as a tombstone with who, when and why, and announces it', () => {
    const id = decide('BullMQ');
    const { events } = withdraw(id);
    expect(getDecision(store.db, id)).toMatchObject({
      choice: 'BullMQ',
      withdrawnAt: AT.toISOString(),
      withdrawnBy: 'me',
      withdrawnReason: 'We never adopted it',
    });
    expect(events.map((e) => [e.type, e.entityId])).toEqual([[EventType.DecisionWithdrawn, id]]);
  });

  it('takes a withdrawn decision out of search and the recent list', () => {
    const kept = decide('pg-boss');
    const gone = decide('BullMQ');
    expect(searched().sort()).toEqual(['BullMQ', 'pg-boss']);
    withdraw(gone);
    expect(searched()).toEqual(['pg-boss']);
    expect(listRecentDecisions(store.db, project.id, 10).map((d) => d.id)).toEqual([kept]);
  });

  it('takes a decision a later one replaced out of search and the recent list, until the later one is withdrawn', () => {
    const first = decide('BullMQ');
    const second = decide('pg-boss', first);
    expect(searched()).toEqual(['pg-boss']);
    expect(listRecentDecisions(store.db, project.id, 10).map((d) => d.id)).toEqual([second]);
    withdraw(second);
    expect(searched()).toEqual(['BullMQ']);
    expect(listRecentDecisions(store.db, project.id, 10).map((d) => d.id)).toEqual([first]);
  });

  it.each([
    ['an empty reason', ''],
    ['a reason of blanks', '   '],
  ])('refuses %s and writes nothing', (_, reason) => {
    const id = decide('BullMQ');
    expect(() => withdraw(id, reason)).toThrow(InvalidError);
    expect(getDecision(store.db, id).withdrawnAt).toBeNull();
  });

  it('refuses a decision that is not the head of its chain, and takes the head', () => {
    const first = decide('BullMQ');
    const second = decide('pg-boss', first);
    expect(() => withdraw(first)).toThrow(ConflictError);
    expect(getDecision(store.db, first).withdrawnAt).toBeNull();
    withdraw(second);
    // With its successor withdrawn, the first is the head again.
    withdraw(first);
    expect(getDecision(store.db, first).withdrawnAt).not.toBeNull();
  });

  it('refuses a decision already withdrawn, and an unknown one', () => {
    const id = decide('BullMQ');
    withdraw(id);
    expect(() => withdraw(id)).toThrow(ConflictError);
    expect(() => withdraw(mintId('Decision'))).toThrow(NotFoundError);
  });
});
