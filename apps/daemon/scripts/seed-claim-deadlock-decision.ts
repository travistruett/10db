import { CardDecider, DecisionRule, mintId, ProjectId } from '@10db/contracts';
import { createStore, openDatabase } from '@10db/db';
import { z } from 'zod';
import { CardTier, postNotice } from '../src/inbox';
import { recordBreak } from '../src/mcp/claim-deadlock-pairs';

/**
 * Seeds one decision of the claim-deadlock rule, with the pair record its Undo forgets, for the Activity and
 * Settings › Decisions end-to-end check. Two real tasks that deadlock would need two live lanes, so the record
 * and the notice are written straight into the database file of a daemon that is idle.
 * Usage: seed-claim-deadlock-decision.ts <database> <json>
 */
const Seed = z.object({ projectId: ProjectId, line: z.string().min(1) });

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) {
  throw new Error('usage: seed-claim-deadlock-decision.ts <database> <json>');
}
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
store.write((ctx) => {
  const a = mintId('Workstream');
  const b = mintId('Workstream');
  recordBreak(ctx, {
    yielder: a,
    other: b,
    contested: [{ kind: 'area', name: 'docs' }],
    queue: false,
  });
  postNotice(ctx, {
    tier: CardTier.Notice,
    projectId: seed.projectId,
    taskId: null,
    key: `claim-deadlock:e2e:${a}`,
    tone: 'info',
    line: seed.line,
    body: 'Two tasks waited on each other, so the later one gave up its claim.',
    decision: {
      by: CardDecider.Rule,
      rule: DecisionRule.ClaimDeadlock,
      confidence: null,
      undo: { state: 'undoable', action: { kind: 'forget_claim_deadlock', a, b } },
    },
  });
});
