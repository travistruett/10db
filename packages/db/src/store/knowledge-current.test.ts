import { NotFoundError, mintId, type KnowledgeTarget } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decisionHead,
  insertDecision,
  supersedeDecision,
  withdrawDecision,
  type NewDecision,
} from './decisions';
import { getSource, insertSource } from './knowledge';
import {
  getPrincipleRow,
  insertPrinciple,
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
