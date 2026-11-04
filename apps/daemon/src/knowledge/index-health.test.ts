import { createTestStore, searchDecisions, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Logger } from '../log';
import { repairKnowledgeIndex } from './index-health';
import { recordDecision } from './records';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function recordingLogger() {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (_fields, message) => {
      errors.push(message ?? '');
    },
    child: () => logger,
  };
  return { logger, errors };
}

const decide = (projectId: ReturnType<typeof seedProject>['id']) =>
  store.write((ctx) =>
    recordDecision(ctx, projectId, {
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'Redis is already deployed',
    }),
  );

describe('repairKnowledgeIndex', () => {
  it('leaves a sound index alone and says nothing', () => {
    const project = seedProject(store);
    decide(project.id);
    const { logger, errors } = recordingLogger();
    expect(repairKnowledgeIndex(store.db, logger)).toEqual({ rebuilt: [], failed: [] });
    expect(errors).toEqual([]);
  });

  it('composes text stored decomposed, so a composed search finds it', () => {
    const project = seedProject(store);
    const { id } = decide(project.id).value;
    store.db.$client
      .prepare('UPDATE decisions SET choice = ? WHERE id = ?')
      .run('한글'.normalize('NFD'), id);
    expect(searchDecisions(store.db, project.id, '한글', 5)).toEqual([]);
    const { logger, errors } = recordingLogger();
    expect(repairKnowledgeIndex(store.db, logger)).toEqual({ rebuilt: [], failed: [] });
    expect(errors).toEqual([]);
    expect(searchDecisions(store.db, project.id, '한글', 5).map((d) => d.id)).toEqual([id]);
  });

  it('composes a decomposed row once a corrupt index is rebuilt, without another start', () => {
    const project = seedProject(store);
    // The row never reached the index, so the update trigger's delete of its old entry finds nothing
    // to delete and fails (SQLITE_CORRUPT_VTAB), which the rebuild then repairs.
    const client = store.db.$client;
    const updateTrigger = z
      .object({ sql: z.string() })
      .parse(
        client.prepare("SELECT sql FROM sqlite_master WHERE name = 'decisions_fts_update'").get(),
      ).sql;
    client.exec('DROP TRIGGER decisions_fts_insert; DROP TRIGGER decisions_fts_update');
    const { id } = decide(project.id).value;
    client.prepare('UPDATE decisions SET choice = ? WHERE id = ?').run('한글'.normalize('NFD'), id);
    client.exec(updateTrigger);
    const { logger } = recordingLogger();
    expect(repairKnowledgeIndex(store.db, logger)).toEqual({
      rebuilt: ['decisions_fts'],
      failed: [],
    });
    expect(searchDecisions(store.db, project.id, '한글', 5).map((d) => d.id)).toEqual([id]);
  });

  it('rebuilds an index out of step with its table, logs it, and search finds the record again', () => {
    const project = seedProject(store);
    store.db.$client.exec('DROP TRIGGER decisions_fts_insert');
    decide(project.id);
    expect(searchDecisions(store.db, project.id, 'queue', 5)).toEqual([]);
    const { logger, errors } = recordingLogger();
    expect(repairKnowledgeIndex(store.db, logger)).toEqual({
      rebuilt: ['decisions_fts'],
      failed: [],
    });
    expect(errors).toEqual(['knowledge search index disagreed with its table; rebuilding it']);
    expect(searchDecisions(store.db, project.id, 'queue', 5).map((d) => d.choice)).toEqual([
      'BullMQ',
    ]);
  });

  it('logs a rebuild that fails on a corrupt shadow table and returns it, without throwing', () => {
    const project = seedProject(store);
    decide(project.id);
    // SQLite's defensive mode keeps FTS5 shadow tables read-only; unsafe mode lets the test corrupt one.
    store.db.$client.unsafeMode(true);
    store.db.$client.exec('DROP TABLE decisions_fts_data; CREATE TABLE decisions_fts_data(x)');
    store.db.$client.unsafeMode(false);
    const { logger, errors } = recordingLogger();
    expect(repairKnowledgeIndex(store.db, logger)).toEqual({
      rebuilt: [],
      failed: ['decisions_fts'],
    });
    expect(errors).toEqual([
      'knowledge search index disagreed with its table; rebuilding it',
      'rebuilding the knowledge search index failed; search over it fails until it is repaired',
    ]);
  });
});
