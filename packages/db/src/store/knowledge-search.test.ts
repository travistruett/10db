import { KnowledgeScope, SourceKind } from '@10db/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { insertDecision } from './decisions';
import { insertSource } from './knowledge';
import { searchDecisionIds } from './knowledge-search';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

it('searches a task described by a whole CI log in well under a second', () => {
  const project = seedProject(store);
  // A project's worth of decisions, each sharing the log's common words.
  const ids = store.write((ctx) =>
    Array.from({ length: 300 }, (_, i) => String(i)).map((n) =>
      insertDecision(ctx, {
        projectId: project.id,
        question: `How does the gate run test shard ${n}?`,
        choice: `Run bash scripts/gate.sh for shard ${n}`,
        rationale: `An expected length assertion error fails the gate ${n}`,
        decidedBy: 'builder',
        scope: KnowledgeScope.Project,
        area: null,
        sourceId: insertSource(ctx, SourceKind.Daemon, {}),
      }),
    ),
  ).value;
  // A Fix CI task's description: the failing jobs' log lines, about 100 KB and 20,000 words.
  const line = (n: string) =>
    `gate-test-1 Run bash scripts/gate.sh job${n} sha${n}abc ${n}ms AssertionError expected length ${n}`;
  const log = Array.from({ length: 1400 }, (_, n) => line(String(n))).join('\n');

  const started = performance.now();
  const hits = searchDecisionIds(store.db, {
    projectId: project.id,
    query: `Fix CI: gate-test-1 on a blocked lane's checkpoint ${log}`,
    limit: 8,
  });
  const elapsedMs = performance.now() - started;

  expect(hits).toHaveLength(8);
  expect(ids).toEqual(expect.arrayContaining(hits));
  expect(elapsedMs).toBeLessThan(1000);
});
