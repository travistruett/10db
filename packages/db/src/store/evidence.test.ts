import { EvidenceKind } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEvidence, insertEvidence, InvalidEvidenceRowError, listEvidence } from './evidence';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function seedWorkstream() {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  return store.write((ctx) => insertWorkstream(ctx, task.id)).value;
}

describe('evidence', () => {
  it('stores a gate result and the builder note, which has no command or exit code', () => {
    const ws = seedWorkstream();
    const base = { workstreamId: ws.id, summary: 'out', logPath: null, commitShas: ['abc'] };
    store.write((ctx) => {
      insertEvidence(ctx, { ...base, kind: EvidenceKind.Gate, command: 'make gate', exitCode: 1 });
      return insertEvidence(ctx, {
        ...base,
        kind: EvidenceKind.Builder,
        summary: 'Rename it',
        command: null,
        exitCode: null,
      });
    });
    expect(listEvidence(store.db, ws.id).map((e) => [e.kind, e.command, e.exitCode])).toEqual([
      ['gate', 'make gate', 1],
      ['builder', null, null],
    ]);
    const note = listEvidence(store.db, ws.id)[1];
    expect(note && getEvidence(store.db, note.id).summary).toBe('Rename it');
  });

  it('reports a stored gate row with no command as an invalid evidence row', () => {
    const ws = seedWorkstream();
    const base = { workstreamId: ws.id, summary: 'out', logPath: null, commitShas: [] };
    const gate = store.write((ctx) =>
      insertEvidence(ctx, { ...base, kind: EvidenceKind.Gate, command: 'make gate', exitCode: 0 }),
    ).value;
    store.db.$client.prepare('UPDATE evidence SET command = NULL WHERE id = ?').run(gate.id);
    expect(() => getEvidence(store.db, gate.id)).toThrow(InvalidEvidenceRowError);
    expect(() => listEvidence(store.db, ws.id)).toThrow(InvalidEvidenceRowError);
  });
});
