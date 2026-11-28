import { ProjectId } from '@10db/contracts';
import { createStore, openDatabase } from '@10db/db';
import { z } from 'zod';
import { flagCard } from '../src/inbox';
import { stallOutOfMovesCard, StallOutOfMovesReason } from '../src/stalls/card';
import { StallFault } from '../src/stalls/restart-rule';
import { StallKind } from '../src/stalls/rules';

/**
 * Seeds the Out of Moves card of a run that stalled again after its one restart, as the stall sweep
 * raises it, for the Inbox's end-to-end check. The card names no run, so its answers act on nothing. The
 * row is written straight into the database file of a daemon that is idle.
 * Usage: seed-stall-card.ts <database> <json>
 */
const Seed = z.object({ projectId: ProjectId, title: z.string().min(1) });

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-stall-card.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
const since = new Date(Date.now() - 60 * 60_000).toISOString();
store.write((ctx) => {
  flagCard(
    ctx,
    stallOutOfMovesCard(
      {
        key: `stuck:run:e2e-${seed.title}`,
        kind: StallKind.Active,
        projectId: seed.projectId,
        workstreamId: null,
        batchId: null,
        title: seed.title,
        reason: 'It is running but has shown no activity.',
        since,
        fingerprint: seed.title,
        actions: [],
        dependencyRunId: null,
        waitingRunIds: [],
      },
      {
        reason: StallOutOfMovesReason.Again,
        fault: StallFault.NoLane,
        defect: null,
        holds: 'It holds its claims (greeting).',
      },
    ),
  );
});
