import { InboxKind, ProjectId, QuestionCategory, Urgency } from '@10db/contracts';
import { createStore, insertInboxItem, openDatabase } from '@10db/db';
import { z } from 'zod';

/**
 * Seeds one open question card for the stakeholder-questions end-to-end check. A lane would raise it
 * through `ask_human`; the check is about routing it from the card, so the row is written straight into
 * the database file of a daemon that is idle. Usage: seed-question-card.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  title: z.string().min(1),
  body: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string() })).min(1),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-question-card.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
store.write((ctx) =>
  insertInboxItem(ctx, {
    projectId: seed.projectId,
    kind: InboxKind.Question,
    title: seed.title,
    body: seed.body,
    options: seed.options,
    recommendation: null,
    category: QuestionCategory.Product,
    urgency: Urgency.Normal,
    detail: null,
    foldKey: null,
    targets: [],
  }),
);
