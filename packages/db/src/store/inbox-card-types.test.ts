import {
  CARD_RESOLUTION,
  InboxKind,
  InboxState,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboxCardTypes } from './inbox-card-types';
import { insertInboxItem, updateInboxItem } from './inbox';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

// A card's type is its fold-key prefix; the counts say what became of the cards raised in each window.

let store: Store;
let close: () => void;
let nowMs: number;
const at = (iso: string): void => {
  nowMs = Date.parse(iso);
};

beforeEach(() => {
  at('2026-11-17T12:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

function raise(
  projectId: ProjectId,
  kind: InboxKind,
  title: string,
  foldKey: string | null,
): InboxItemId {
  return store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind,
      title,
      body: '',
      options: [],
      recommendation: null,
      category: 'engineering',
      urgency: 'normal',
      detail: null,
      foldKey,
      targets: [],
    }),
  ).value.id;
}

function close_(id: InboxItemId, patch: Parameters<typeof updateInboxItem>[2]): void {
  store.write((ctx) => updateInboxItem(ctx, id, patch));
}

const OVERLOAD = 'machine-overloaded';

describe('inboxCardTypes', () => {
  it('counts what became of each type, in the 7 and 30 day windows apart', () => {
    const project = seedProject(store);
    // 20 days ago: in the 30 day window only.
    at('2026-10-28T12:00:00.000Z');
    const old = raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD);
    close_(old, { state: InboxState.Cancelled });
    // 40 days ago: in neither.
    at('2026-10-08T12:00:00.000Z');
    close_(raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD), {
      state: InboxState.Cancelled,
    });

    at('2026-11-15T12:00:00.000Z');
    // The overload card: withdrawn by 10db three ways, one still open.
    close_(raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD), {
      state: InboxState.Cancelled,
    });
    close_(raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD), {
      state: InboxState.Expired,
    });
    close_(raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD), {
      state: InboxState.Resolved,
      detail: { [CARD_RESOLUTION]: { by: '10db', reason: 'The load fell' } },
    });
    raise(project.id, InboxKind.Flag, 'Overloaded', OVERLOAD);
    // Stray writes: one fold key per path, one type; dismissed twice, never a choice.
    for (const rel of ['.git', '.git/HEAD']) {
      close_(raise(project.id, InboxKind.Flag, 'Stray write', `stray-write:/repo:${rel}`), {
        state: InboxState.Resolved,
        answer: { choice: 'dismissed' },
      });
    }
    // A card that offered a Dismiss option beside real ones.
    close_(raise(project.id, InboxKind.Flag, 'Skipped', 'skipped:ws:none:none'), {
      state: InboxState.Resolved,
      answer: { choice: 'Dismiss' },
    });
    close_(raise(project.id, InboxKind.Flag, 'Skipped', 'skipped:ws:none:none'), {
      state: InboxState.Resolved,
      answer: { choice: 'Run These Now' },
    });
    // No fold key: a flag by its title before the colon, anything else by its kind.
    close_(raise(project.id, InboxKind.Flag, 'Workstream failed: Add a thing', null), {
      state: InboxState.Resolved,
      answer: { choice: 'Retry' },
    });
    close_(raise(project.id, InboxKind.Question, 'Which database?', null), {
      state: InboxState.Answered,
      answer: { choice: 'SQLite' },
    });

    const other = seedProject(store, { name: 'other' });
    raise(other.id, InboxKind.Flag, 'Overloaded', OVERLOAD);

    const byType = Object.fromEntries(
      inboxCardTypes(store.db, project.id, new Date(nowMs)).map((t) => [t.type, t]),
    );
    expect(byType[OVERLOAD]).toMatchObject({
      last7Days: { raised: 4, acted: 0, dismissed: 0, withdrawn: 3 },
      last30Days: { raised: 5, acted: 0, dismissed: 0, withdrawn: 4 },
    });
    expect(byType['stray-write']).toMatchObject({
      last7Days: { raised: 2, acted: 0, dismissed: 2, withdrawn: 0 },
    });
    expect(byType['skipped']).toMatchObject({
      last7Days: { raised: 2, acted: 1, dismissed: 1, withdrawn: 0 },
    });
    expect(byType['Workstream failed']).toMatchObject({
      last7Days: { raised: 1, acted: 1, dismissed: 0, withdrawn: 0 },
    });
    expect(byType['question']).toMatchObject({
      last7Days: { raised: 1, acted: 1, dismissed: 0, withdrawn: 0 },
    });
  });

  it('marks a type mostly dismissed or withdrawn as noisy, and lists the noisy first', () => {
    const project = seedProject(store);
    for (let i = 0; i < 5; i += 1)
      close_(raise(project.id, InboxKind.Flag, 'Stray', `stray-write:/r:${String(i)}`), {
        state: InboxState.Resolved,
        answer: { choice: 'dismissed' },
      });
    // More raised, but acted on: not noisy.
    for (let i = 0; i < 9; i += 1)
      close_(raise(project.id, InboxKind.Question, `Q${String(i)}`, null), {
        state: InboxState.Answered,
        answer: { choice: 'Yes' },
      });

    const types = inboxCardTypes(store.db, project.id, new Date(nowMs));
    expect(types.map((t) => [t.type, t.noisy])).toEqual([
      ['stray-write', true],
      ['question', false],
    ]);
  });
});
