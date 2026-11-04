import { NotFoundError, mintId, type KnowledgeTarget, type PrincipleId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentDecisionOf,
  decisionHead,
  getDecision,
  insertDecision,
  supersedeDecision,
  withdrawDecision,
  type NewDecision,
} from './decisions';
import { getSource, insertProposal, insertSource } from './knowledge';
import {
  confirmPrinciple,
  currentPrincipleOf,
  getPrincipleRow,
  insertPrinciple,
  pendingProposalOf,
  principleHead,
  retirePrinciple,
  supersedePrinciple,
  withdrawPrinciple,
} from './principles';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

// A script that meets a 409 needs the id of the record that is current, not only that its own is not.

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function decisionChain() {
  const project = seedProject(store);
  const input = (choice: string): NewDecision =>
    store.write((ctx) => ({
      projectId: project.id,
      question: 'Which queue library?',
      choice,
      rationale: 'r',
      decidedBy: 'me',
      scope: 'project' as const,
      area: null,
      sourceId: insertSource(ctx, 'builder', {}),
    })).value;
  const a = store.write((ctx) => insertDecision(ctx, input('BullMQ'))).value;
  const b = store.write((ctx) => supersedeDecision(ctx, a, input('pg-boss'))).value;
  const c = store.write((ctx) => supersedeDecision(ctx, b, input('graphile'))).value;
  return { a, b, c };
}

function principleChain() {
  const project = seedProject(store);
  const target: KnowledgeTarget = { scope: 'project', projectId: project.id };
  const first = store.write((ctx) =>
    insertPrinciple(ctx, {
      target,
      statement: 'Never sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      status: 'confirmed',
      sourceId: insertSource(ctx, 'builder', {}),
      sourceQuote: null,
      speaker: 'me',
      confirmedBy: 'me',
    }),
  ).value;
  const next = (id: typeof first.id, statement: string) =>
    store.write((ctx) =>
      supersedePrinciple(ctx, id, {
        statement,
        sourceId: insertSource(ctx, 'builder', {}),
        confirmedBy: 'me',
      }),
    ).value;
  const second = next(first.id, 'Never sleep in unit tests');
  const third = next(second.id, 'Never sleep in any test');
  return { first, second, third };
}

describe('naming the current record', () => {
  it('finds the head of a decision chain from any link', () => {
    const { a, b, c } = decisionChain();
    expect([a, b, c].map((id) => decisionHead(store.db, id))).toEqual([c, c, c]);
  });

  it('names the current decision when a superseded one is superseded or withdrawn', () => {
    const { a, c } = decisionChain();
    const again = (): NewDecision => ({
      projectId: null,
      question: 'q',
      choice: 'c',
      rationale: 'r',
      decidedBy: 'me',
      scope: 'you',
      area: null,
      sourceId: store.write((ctx) => insertSource(ctx, 'builder', {})).value,
    });
    expect(() => store.write((ctx) => supersedeDecision(ctx, a, again()))).toThrow(
      new RegExp(`only a current decision.*${c}`),
    );
    expect(() =>
      store.write((ctx) => {
        withdrawDecision(ctx, a, { by: 'me', reason: 'x' });
      }),
    ).toThrow(new RegExp(`current one is ${c}`));
  });

  it('finds the head of a principle chain from any link', () => {
    const { first, second, third } = principleChain();
    expect([first, second, third].map((p) => principleHead(store.db, p.id))).toEqual(
      [third, third, third].map((p) => p.id),
    );
  });

  it('names the current principle when a superseded one is superseded, retired or withdrawn', () => {
    const { first, third } = principleChain();
    const sourceId = store.write((ctx) => insertSource(ctx, 'builder', {})).value;
    expect(() =>
      store.write((ctx) =>
        supersedePrinciple(ctx, first.id, { statement: 'x', sourceId, confirmedBy: 'me' }),
      ),
    ).toThrow(new RegExp(`only a current principle.*${third.id}`));
    expect(() => store.write((ctx) => retirePrinciple(ctx, first.id, 'me', 'gone'))).toThrow(
      new RegExp(`only a current principle.*${third.id}`),
    );
    expect(() => store.write((ctx) => withdrawPrinciple(ctx, first.id, 'me', 'gone'))).toThrow(
      new RegExp(`current one is ${third.id}`),
    );
  });
});

describe('naming the live record when the head is not current', () => {
  const decisionInput = (): NewDecision => ({
    projectId: null,
    question: 'q',
    choice: 'c',
    rationale: 'r',
    decidedBy: 'me',
    scope: 'you',
    area: null,
    sourceId: store.write((ctx) => insertSource(ctx, 'builder', {})).value,
  });
  const supersedeWith = (id: PrincipleId) =>
    store.write((ctx) =>
      supersedePrinciple(ctx, id, {
        statement: 'x',
        sourceId: insertSource(ctx, 'builder', {}),
        confirmedBy: 'me',
      }),
    );

  it('finds the predecessor of a withdrawn decision head, however many were withdrawn', () => {
    const { a, b, c } = decisionChain();
    store.write((ctx) => {
      withdrawDecision(ctx, c, { by: 'me', reason: 'wrong' });
      withdrawDecision(ctx, b, { by: 'me', reason: 'wrong' });
    });
    expect([a, b, c].map((id) => currentDecisionOf(store.db, id))).toEqual([a, a, a]);
    expect(() => store.write((ctx) => supersedeDecision(ctx, c, decisionInput()))).toThrow(
      new RegExp(`only a current decision.*current one is ${a}`),
    );
    expect(() =>
      store.write((ctx) => {
        withdrawDecision(ctx, c, { by: 'me', reason: 'again' });
      }),
    ).toThrow(new RegExp(`already withdrawn.*current one is ${a}`));
  });

  it('follows a withdrawn decision to the successor that later replaced its predecessor', () => {
    const { b, c } = decisionChain();
    store.write((ctx) => {
      withdrawDecision(ctx, c, { by: 'me', reason: 'wrong' });
    });
    const d = store.write((ctx) => supersedeDecision(ctx, b, decisionInput())).value;
    expect(currentDecisionOf(store.db, c)).toBe(d);
  });

  it('says no decision is current when the whole chain is withdrawn', () => {
    const { a, b, c } = decisionChain();
    store.write((ctx) => {
      withdrawDecision(ctx, c, { by: 'me', reason: 'wrong' });
      withdrawDecision(ctx, b, { by: 'me', reason: 'wrong' });
      withdrawDecision(ctx, a, { by: 'me', reason: 'wrong' });
    });
    expect(currentDecisionOf(store.db, c)).toBeNull();
    expect(() => store.write((ctx) => supersedeDecision(ctx, c, decisionInput()))).toThrow(
      /none is current/,
    );
    expect(() =>
      store.write((ctx) => {
        withdrawDecision(ctx, a, { by: 'me', reason: 'again' });
      }),
    ).toThrow(/already withdrawn.*none is current/);
  });

  it('finds the predecessor of a withdrawn principle head', () => {
    const { first, second, third } = principleChain();
    store.write((ctx) => {
      withdrawPrinciple(ctx, third.id, 'me', 'wrong');
      withdrawPrinciple(ctx, second.id, 'me', 'wrong');
    });
    expect(currentPrincipleOf(store.db, third.id)).toBe(first.id);
    expect(() => supersedeWith(third.id)).toThrow(
      new RegExp(`only a current principle.*current one is ${first.id}`),
    );
    expect(() => store.write((ctx) => retirePrinciple(ctx, third.id, 'me', 'x'))).toThrow(
      new RegExp(`only a current principle.*current one is ${first.id}`),
    );
    expect(() => store.write((ctx) => withdrawPrinciple(ctx, third.id, 'me', 'x'))).toThrow(
      new RegExp(`only a current or proposed.*current one is ${first.id}`),
    );
  });

  it('does not name a retired head as current', () => {
    const { first, second, third } = principleChain();
    store.write((ctx) => retirePrinciple(ctx, third.id, 'me', 'obsolete'));
    for (const id of [first.id, second.id, third.id]) {
      expect(currentPrincipleOf(store.db, id)).toBeNull();
      expect(() => supersedeWith(id)).toThrow(/none is current/);
      expect(() => store.write((ctx) => retirePrinciple(ctx, id, 'me', 'x'))).toThrow(
        /none is current/,
      );
      expect(() => store.write((ctx) => withdrawPrinciple(ctx, id, 'me', 'x'))).toThrow(
        /none is current/,
      );
    }
  });

  it('names the principle that took the key after a chain ended', () => {
    const { first, third } = principleChain();
    store.write((ctx) => retirePrinciple(ctx, third.id, 'me', 'obsolete'));
    const taken = store.write((ctx) =>
      insertPrinciple(ctx, {
        target: { scope: 'project', projectId: first.projectId ?? mintId('Project') },
        statement: 'Wait on a condition',
        kind: 'policy',
        topicKey: first.topicKey,
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: 'me',
      }),
    ).value;
    expect(currentPrincipleOf(store.db, first.id)).toBe(taken.id);
  });

  it('names the proposal that decides a proposed principle', () => {
    const project = seedProject(store);
    const proposed = store.write((ctx) => {
      const sourceId = insertSource(ctx, 'agent', {});
      const principle = insertPrinciple(ctx, {
        target: { scope: 'project', projectId: project.id },
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        status: 'proposed',
        sourceId,
        sourceQuote: null,
        speaker: 'agent:x',
        confirmedBy: null,
      });
      const proposalId = insertProposal(ctx, {
        projectId: project.id,
        kind: 'principle',
        title: 't',
        body: 'b',
        sourceId,
        principleId: principle.id,
      });
      return { principle, proposalId };
    }).value;
    expect(pendingProposalOf(store.db, proposed.principle.id)).toBe(proposed.proposalId);
    expect(() => supersedeWith(proposed.principle.id)).toThrow(
      new RegExp(`is proposed.*${proposed.proposalId}`),
    );
    const { first } = principleChain();
    expect(pendingProposalOf(store.db, first.id)).toBeNull();
  });
});

describe('the source of a retire, a withdrawal and a confirmation', () => {
  it('stores it on the row, and leaves the column empty when the write names none', () => {
    const { second, third } = principleChain();
    const { a, b, c } = decisionChain();
    const { withdrawn, retired, decided } = store.write((ctx) => ({
      withdrawn: insertSource(ctx, 'builder', { via: 'claude_code' }),
      retired: insertSource(ctx, 'builder', { via: 'claude_code' }),
      decided: insertSource(ctx, 'builder', { via: 'claude_code' }),
    })).value;
    store.write((ctx) => {
      withdrawPrinciple(ctx, third.id, 'me', 'wrong', withdrawn);
      retirePrinciple(ctx, second.id, 'me', 'obsolete', retired);
      withdrawDecision(ctx, c, { by: 'me', reason: 'wrong', sourceId: decided });
      withdrawDecision(ctx, b, { by: 'me', reason: 'wrong' });
    });
    expect(getPrincipleRow(store.db, third.id).withdrawnSourceId).toBe(withdrawn);
    expect(getPrincipleRow(store.db, second.id).retiredSourceId).toBe(retired);
    expect(getDecision(store.db, c).withdrawnSourceId).toBe(decided);
    expect(getDecision(store.db, b).withdrawnSourceId).toBeNull();
    expect(getDecision(store.db, a).withdrawnSourceId).toBeNull();
  });

  it('stores the source that confirmed a proposed principle', () => {
    const project = seedProject(store);
    const target: KnowledgeTarget = { scope: 'project', projectId: project.id };
    const { id, sourceId } = store.write((ctx) => {
      const made = insertPrinciple(ctx, {
        target,
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        status: 'proposed',
        sourceId: insertSource(ctx, 'agent', {}),
        sourceQuote: null,
        speaker: 'agent:x',
        confirmedBy: null,
      });
      return { id: made.id, sourceId: insertSource(ctx, 'builder', { via: 'claude_code' }) };
    }).value;
    store.write((ctx) =>
      confirmPrinciple(ctx, id, { target, confirmedBy: 'me', confirmedSourceId: sourceId }),
    );
    expect(getPrincipleRow(store.db, id).confirmedSourceId).toBe(sourceId);
  });
});

describe('reading a record back for provenance', () => {
  it('reads a source with its kind, ref and time', () => {
    const id = store.write((ctx) =>
      insertSource(ctx, 'builder', { via: 'claude_code', sessionId: 's1' }),
    ).value;
    expect(getSource(store.db, id)).toMatchObject({
      id,
      kind: 'builder',
      ref: { via: 'claude_code', sessionId: 's1' },
    });
    expect(() => getSource(store.db, mintId('Source'))).toThrow(NotFoundError);
  });

  it('reads who retired and who withdrew a principle', () => {
    const { second, third } = principleChain();
    store.write((ctx) => withdrawPrinciple(ctx, third.id, 'wiper', 'gone'));
    // withdrawing the head makes the second link current again, so it can be retired
    store.write((ctx) => retirePrinciple(ctx, second.id, 'someone', 'obsolete'));
    expect(getPrincipleRow(store.db, third.id)).toMatchObject({ withdrawnBy: 'wiper' });
    expect(getPrincipleRow(store.db, second.id)).toMatchObject({ retiredBy: 'someone' });
  });

  it('refuses an unknown principle', () => {
    expect(() => getPrincipleRow(store.db, mintId('Principle'))).toThrow(NotFoundError);
  });
});
