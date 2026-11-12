import { mintId, type TaskDto, type TaskMessageId } from '@10db/contracts';
import {
  createTestStore,
  getTaskMessageRow,
  insertBuilderMessage,
  insertSystemNotice,
  insertTask,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { buildThreadDigest, builderMessageText } from './session-text';

// Workbench spec §6.3: a fresh session starts from the thread's digest, built from rows, after the
// latest handoff when there is one, with each pasted picture named by where it is kept.

let store: Store;
let close: () => void;
let clock: ManualClock;
let task: TaskDto;
beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  const project = seedProject(store, { name: 'alpha' });
  task = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Settings page',
      description: 'Tidy the settings page.',
      acceptanceCriteria: ['x'],
      areas: ['ui'],
    }),
  ).value;
});
afterEach(() => {
  close();
});

const say = (body: string, files: { name: string; storedPath: string }[] = []) => {
  clock.advance(1_000);
  return store.write((ctx) =>
    insertBuilderMessage(ctx, task.id, {
      body,
      files: files.map((f) => ({
        ...f,
        mediaType: 'image/png' as const,
        size: 10,
        sha256: 'a'.repeat(64),
      })),
    }),
  ).value;
};

/** The agent's reply as the end of a turn writes it; no writer of replies exists before pass turns. */
const reply = (body: string): void => {
  clock.advance(1_000);
  store.db.$client
    .prepare(
      "insert into task_messages (id, task_id, author, kind, body, created_at) values (?, ?, 'agent', 'reply', ?, ?)",
    )
    .run(mintId('TaskMessage'), task.id, body, clock.now().toISOString());
};

describe('buildThreadDigest', () => {
  it("gives the brief, then what the builder and the agent said before the message, naming each picture's path", () => {
    say('Make the header smaller', [
      { name: 'header.png', storedPath: '/data/tasks/t/files/a.png' },
    ]);
    reply('Header is 20% smaller.');
    store.write((ctx) => insertSystemNotice(ctx, task.id, 'Started a fresh session'));
    const now = say('Now the footer');
    say('Sent after it');

    const digest = buildThreadDigest(store.db, task, { after: null, before: now.id });
    expect(digest).toContain('The brief: Settings page\nTidy the settings page.');
    expect(digest).toContain('[Picture header.png, kept at /data/tasks/t/files/a.png: Read it');
    const said = digest.split('\n').filter((line) => line.startsWith('['));
    expect(said.map((line) => line.split(']')[0])).toEqual([
      expect.stringMatching(/^\[builder, message tmg_/),
      '[Picture header.png, kept at /data/tasks/t/files/a.png: Read it to see it.',
      '[your reply',
    ]);
    expect(digest).not.toContain('Started a fresh session');
    expect(digest).not.toContain('Now the footer');
    expect(digest).not.toContain('Sent after it');
  });

  it('leaves out what was said before the latest handoff, which carries it', () => {
    say('Before the handoff');
    clock.advance(1_000);
    const handoffAt = clock.now().toISOString();
    say('After the handoff');
    const now: TaskMessageId = say('The message').id;

    const digest = buildThreadDigest(store.db, task, { after: handoffAt, before: now });
    expect(digest).toContain('The thread since the latest handoff:');
    expect(digest).toContain('After the handoff');
    expect(digest).not.toContain('Before the handoff');
  });
});

describe('builderMessageText', () => {
  it('names the message by its id and says a message under an id seen before is that same one', () => {
    const message = getTaskMessageRow(store.db, say('Make it blue').id);
    const text = builderMessageText(message, new Set());
    expect(text).toContain(`(message ${message.id}):\nMake it blue`);
    expect(text).toMatch(/same id .* is the same message/);
  });
});
