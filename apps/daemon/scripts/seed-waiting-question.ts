import { InboxKind, ProjectId, QuestionCategory, Urgency, WorkstreamState } from '@10db/contracts';
import {
  createStore,
  insertDraft,
  insertInboxItem,
  insertPerson,
  insertTask,
  insertWorkstream,
  markSending,
  markSent,
  openDatabase,
  transitionWorkstream,
} from '@10db/db';
import { z } from 'zod';

/**
 * Seeds a task whose run waits on a question that was sent to Mark in Slack, for the end-to-end check of
 * the Board's "Waiting on Mark in Slack" line. Nothing is sent: the rows are written straight into the
 * database file of a daemon that is idle. Usage: seed-waiting-question.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  taskTitle: z.string().min(1),
  area: z.string().min(1),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-waiting-question.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));

const sentAt = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
const mark = store.write((ctx) =>
  insertPerson(ctx, {
    handle: 'mark',
    name: 'Mark Ellis',
    slack: { teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 },
  }),
).value;
const task = store.write((ctx) =>
  insertTask(ctx, seed.projectId, {
    title: seed.taskTitle,
    acceptanceCriteria: ['an answer'],
    areas: [seed.area],
  }),
).value;
const workstream = store.write((ctx) =>
  insertWorkstream(ctx, task.id, { first: { model: 'seeded-model', effort: 'medium' } }),
).value;
for (const to of [
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.WaitingHuman,
] as const)
  store.write((ctx) => {
    transitionWorkstream(ctx, workstream.id, { to, fence: null, reason: 'seeded' });
  });
const card = store.write((ctx) =>
  insertInboxItem(ctx, {
    projectId: seed.projectId,
    kind: InboxKind.Question,
    title: 'Which retry window?',
    body: '',
    options: [{ label: 'Seven days', description: '' }],
    recommendation: null,
    category: QuestionCategory.Product,
    urgency: Urgency.Normal,
    detail: null,
    foldKey: null,
    targets: [{ workstreamId: workstream.id, sessionId: null }],
  }),
).value;
const send = store.write((ctx) =>
  insertDraft(ctx, { inboxItemId: card.id, recipients: [mark.id], text: 'Hi', hits: [] }),
).value;
store.write((ctx) => {
  markSending(ctx, send.id, { textSha256: 'seeded', threadTs: null, startedAt: sentAt });
});
store.write((ctx) => {
  markSent(ctx, send.id, {
    channelId: 'D1',
    threadTs: '1.1',
    messageTs: '1.1',
    permalink: null,
    at: sentAt,
  });
});
