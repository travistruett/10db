import {
  AcceptanceDetail,
  GUARDRAIL_DIFF_DETAIL,
  GuardrailDiffDetail,
  InboxKind,
  PersonInput,
  ProjectId,
  QuestionCategory,
  Urgency,
} from '@10db/contracts';
import {
  createStore,
  insertInboxItem,
  insertPerson,
  openDatabase,
  setAppSetting,
  type Json,
} from '@10db/db';
import { z } from 'zod';
import { stampFile } from '../src/inbox';

/**
 * Seeds one open question card for the stakeholder-questions end-to-end check. A lane would raise it
 * through `ask_human`; the check is about routing it from the card, so the row is written straight into
 * the database file of a daemon that is idle. It may also sign in Slack workspaces (the `slack.workspaces`
 * setting, with no token) and add people with their contacts. With `acceptance` it writes an acceptance card
 * instead, as the acceptance check raises one, for the Inbox check. Usage: seed-question-card.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  title: z.string().min(1),
  body: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string() })).min(1),
  workspaces: z.array(z.object({ teamId: z.string().min(1), teamName: z.string() })).default([]),
  people: z.array(PersonInput).default([]),
  acceptance: AcceptanceDetail.nullable().default(null),
  /** A lane's write to a guardrail file, as the watcher raises its card: the file's stamp is read from disk here. */
  stray: z
    .object({ root: z.string().min(1), path: z.string().min(1), diff: GuardrailDiffDetail })
    .nullable()
    .default(null),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-question-card.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));
const strayDetail = (stray: NonNullable<typeof seed.stray>): Record<string, Json> => ({
  path: stray.path,
  root: stray.root,
  sha256: String(stampFile(stray.root, stray.path)),
  foldKey: `stray-write:${seed.projectId}:${stray.path}`,
  [GUARDRAIL_DIFF_DETAIL]: stray.diff,
});
store.write((ctx) =>
  insertInboxItem(ctx, {
    projectId: seed.projectId,
    kind:
      seed.stray !== null
        ? InboxKind.Flag
        : seed.acceptance === null
          ? InboxKind.Question
          : InboxKind.Acceptance,
    title: seed.title,
    body: seed.body,
    options: seed.options,
    recommendation: null,
    category: QuestionCategory.Product,
    urgency: Urgency.Normal,
    detail: seed.stray === null ? seed.acceptance : strayDetail(seed.stray),
    foldKey: null,
    targets: [],
  }),
);
if (seed.workspaces.length > 0)
  store.write((ctx) => {
    setAppSetting(ctx, 'slack.workspaces', seed.workspaces);
  });
for (const person of seed.people) store.write((ctx) => insertPerson(ctx, person));
