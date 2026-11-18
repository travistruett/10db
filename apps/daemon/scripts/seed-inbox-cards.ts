import { InboxKind, InboxState, ProjectId, QuestionCategory, Urgency } from '@10db/contracts';
import { createStore, insertInboxItem, openDatabase, updateInboxItem } from '@10db/db';
import { z } from 'zod';

/**
 * Seeds many Inbox cards for the Inbox's end-to-end timings: flags with distinct titles, every tenth one a
 * question, and `grouped` sets of three identical flags among them. Resolved cards are answered through the
 * store, a minute apart. The rows are written straight into the database file of a daemon that is idle.
 * Usage: seed-inbox-cards.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  count: z.int().positive(),
  state: z.enum(['open', 'resolved']),
  grouped: z.int().nonnegative().optional(),
});

const MINUTE_MS = 60_000;
const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-inbox-cards.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const groupedCards = (seed.grouped ?? 0) * 3;
if (groupedCards > seed.count) throw new Error('grouped sets need more cards than count');

const db = openDatabase(databasePath);
// The clock is the store's own, so a resolved card's `updated_at` is set by the write that answers it.
let now = new Date();
const store = createStore(db, () => now);

const label = (index: number): string =>
  `${seed.state === 'open' ? 'Open' : 'Resolved'} card ${String(index).padStart(4, '0')}`;

const cards = store.write((ctx) =>
  Array.from({ length: seed.count }, (_, index) => {
    const isQuestion = index >= groupedCards && index % 10 === 0;
    const group = Math.floor(index / 3);
    return insertInboxItem(ctx, {
      projectId: seed.projectId,
      kind: isQuestion ? InboxKind.Question : InboxKind.Flag,
      title: index < groupedCards ? `${label(group)} repeated` : label(index),
      body: index < groupedCards ? 'The same thing, again.' : `Details of ${label(index)}.`,
      options: isQuestion
        ? [
            { label: 'Seven days', description: '' },
            { label: 'The whole billing period', description: '' },
          ]
        : [],
      recommendation: null,
      category: QuestionCategory.Product,
      urgency: Urgency.Normal,
      detail: null,
      foldKey: null,
      targets: [],
    });
  }),
).value;

if (seed.state === 'resolved') {
  const start = Date.now() - seed.count * MINUTE_MS;
  cards.forEach((card, index) => {
    now = new Date(start + index * MINUTE_MS);
    store.write((ctx) =>
      updateInboxItem(ctx, card.id, {
        state: InboxState.Resolved,
        answer: { choice: card.options[0]?.label ?? 'dismissed' },
      }),
    );
  });
}
