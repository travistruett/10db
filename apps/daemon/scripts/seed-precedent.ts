import {
  PrecedentExample,
  PrecedentKind,
  PrecedentScope,
  PrecedentState,
  ProgramKey,
  ProjectId,
} from '@10db/contracts';
import { approvePrecedent, createStore, openDatabase } from '@10db/db';
import { z } from 'zod';

/**
 * Seeds one active standing approval for the project Trust end-to-end check. The builder makes one by answering
 * the proposal card, which needs skips of 10db's judge in two runs; the check is about listing and removing it, so
 * the row is written straight into the database file of a daemon that is idle, through the store function the
 * answer route uses. Usage: seed-precedent.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  programKey: ProgramKey,
  kind: PrecedentKind,
  examples: z.array(PrecedentExample).default([]),
  scope: z.enum(PrecedentScope).default(PrecedentScope.Project),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-precedent.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
store.write((ctx) =>
  approvePrecedent(ctx, {
    projectId: seed.projectId,
    programKey: seed.programKey,
    scope: seed.scope,
    kind: seed.kind,
    examples: seed.examples,
    runsHash: null,
    state: PrecedentState.Active,
    sourceInboxId: null,
  }),
);
