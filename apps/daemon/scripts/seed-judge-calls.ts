import { JudgeDecision, JudgeOutcome } from '@10db/contracts';
import { createStore, insertJudgeCall, openDatabase } from '@10db/db';
import { z } from 'zod';

/**
 * Seeds judge calls for the Decisions page's end-to-end check. The e2e daemon runs with the judge off, so it
 * logs no answered call itself; the rows are written straight into the database file of a daemon that is idle.
 * Usage: seed-judge-calls.ts <database> <json>
 */
const Seed = z.object({
  calls: z
    .array(
      z.object({
        decision: z.enum(JudgeDecision),
        model: z.string().min(1),
        answer: z.string().nullable(),
        confidence: z.number().min(0).max(1).nullable(),
        outcome: z.enum(JudgeOutcome),
        latencyMs: z.number().nonnegative().nullable(),
        costUsd: z.number().nonnegative().nullable(),
      }),
    )
    .min(1),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-judge-calls.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
store.write((ctx) => {
  for (const call of seed.calls)
    insertJudgeCall(ctx, {
      ...call,
      state: 'Seeded for the end-to-end check.',
      question: 'Seeded question',
      workstreamId: null,
      taskId: null,
    });
});
