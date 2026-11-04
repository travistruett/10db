import { PlanDraft, ShapeMessageAuthor, ShapeMessageKind } from '@10db/contracts';
import { insertShapeMessage, listShapeProposals } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedConversation, looseDraft, type ConversationFixture } from './conversation-fixture';
import { buildDigest, DIGEST_MESSAGES } from './digest';
import { convertProposals } from './convert';
import { reconcileDraft } from './rounds';

// Shape spec §5.3: a deterministic digest seeds a new SDK session: the last 40 messages verbatim,
// the current proposals and the conversation's links, each row with its source ids.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

describe('buildDigest', () => {
  it('holds the last messages verbatim, builder messages under their ids, and no earlier ones', () => {
    const ids = Array.from({ length: DIGEST_MESSAGES + 5 }, (_, i) =>
      c.say(`message ${String(i)}`),
    );
    c.store.write((ctx) =>
      insertShapeMessage(ctx, c.shape.id, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Claude’s last answer',
      }),
    );
    const digest = buildDigest(c.store.db, c.shape.id);
    expect(digest).toContain('Claude’s last answer');
    expect(digest).toContain(`[m:${ids.at(-1) ?? ''}] message ${String(DIGEST_MESSAGES + 4)}`);
    // 40 messages are kept: Claude's answer and the 39 builder messages before it.
    expect(digest).not.toContain('message 5\n');
    expect(digest).toContain('message 6');
    expect(digest.match(/\[m:/g)).toHaveLength(DIGEST_MESSAGES - 1);
  });

  it('says a screenshot was taken, and where, without its row’s JSON: the picture is not carried over', () => {
    c.say('How does the board look?');
    c.store.write((ctx) =>
      insertShapeMessage(ctx, c.shape.id, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Screen,
        body: JSON.stringify({
          screen: 'board',
          width: 1200,
          height: 900,
          name: '0001.png',
          mediaType: 'image/png',
        }),
      }),
    );
    const digest = buildDigest(c.store.db, c.shape.id);
    expect(digest).toContain('(claude) [A screenshot of the board at 1200×900 was taken here');
    expect(digest).toContain('see_screen');
    expect(digest).not.toContain('0001.png');
    expect(digest).not.toContain('mediaType');
  });

  it('lists each proposal with its state and sources, and what Convert made', () => {
    const m = c.say('Do the thing.');
    c.store.write((ctx) =>
      reconcileDraft(ctx, c.shape.id, PlanDraft.parse(looseDraft(m, 'a', 'b'))),
    );
    const rows = listShapeProposals(c.store.db, c.shape.id);
    const a = rows.find((r) => r.key === 'a');
    c.store.write((ctx) => convertProposals(ctx, c.shape.id, a === undefined ? [] : [a.id]));
    const digest = buildDigest(c.store.db, c.shape.id);
    expect(digest).toContain(`- a (task, accepted, round 1; sources ${m}): Task a`);
    expect(digest).toContain(`- b (task, pending, round 1; sources ${m}): Task b`);
    expect(digest).toMatch(/a → task tsk_/);
  });

  it('says what a converted principle and question became', () => {
    const m = c.say('Never sleep in tests.');
    c.store.write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          records: [
            {
              key: 'no-sleeps',
              kind: 'principle',
              scope: 'project',
              statement: 'Never sleep in tests',
              rationale: 'Flaky.',
              sourceMessageIds: [m],
            },
          ],
          questions: [{ key: 'who', text: 'Who pays?', for: 'finance', sourceMessageIds: [m] }],
        }),
      ),
    );
    const ids = listShapeProposals(c.store.db, c.shape.id).map((r) => r.id);
    c.store.write((ctx) => convertProposals(ctx, c.shape.id, ids));
    const digest = buildDigest(c.store.db, c.shape.id);
    expect(digest).toMatch(/no-sleeps → principle pri_[\w-]+ "Never sleep in tests" — current/);
    expect(digest).toMatch(/who → question sqn_[\w-]+ "Who pays\?" for finance — stored/);
  });

  it('says so when nothing has been proposed yet', () => {
    c.say('Hello');
    expect(buildDigest(c.store.db, c.shape.id)).toContain('Nothing is proposed yet.');
  });
});
