import { mintId, type InboxItemDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto, taskDto } from '../../test/fixtures';
import { refusalCards, startNote, type StartAttempt } from './start-note';

const task = taskDto({ title: 'Alpha', workstreamId: null });
const refusal = inboxItemDto({
  kind: 'flag',
  title: 'Batch not started: the checkout has uncommitted changes',
  detail: { taskIds: [task.id] },
  updatedAt: '2026-10-29T10:00:00.000Z',
});
const requesting: StartAttempt = { phase: 'requesting', workstreamId: null, seen: null };

describe('refusalCards', () => {
  it('maps each named task to its newest open flag', () => {
    const older = inboxItemDto({
      kind: 'flag',
      detail: { taskIds: [task.id] },
      updatedAt: '2026-10-29T09:00:00.000Z',
    });
    const other = inboxItemDto({ kind: 'flag', detail: { taskIds: ['task_other'] } });
    const cards = refusalCards([older, refusal, other]);
    expect(cards.get(task.id)).toBe(refusal);
    expect(cards.size).toBe(2);
  });

  it.each<{ name: string; item: Partial<InboxItemDto> }>([
    { name: 'a card that names no task', item: { detail: null } },
    { name: 'a card whose detail is another shape', item: { detail: { taskIds: 'x' } } },
    { name: 'a question, not a flag', item: { kind: 'permission', detail: { taskIds: ['t'] } } },
  ])('ignores $name', ({ item }) => {
    expect(refusalCards([inboxItemDto({ kind: 'flag', ...item })]).size).toBe(0);
  });
});

describe('startNote', () => {
  it.each([
    {
      name: 'nothing asked and nothing refused',
      attempt: undefined,
      card: undefined,
      startable: true,
      note: null,
    },
    {
      name: 'a request on its way',
      attempt: requesting,
      card: undefined,
      startable: true,
      note: { kind: 'starting', line: 'Starting…', inbox: false },
    },
    {
      name: 'a request answered and the daemon still checking',
      attempt: { ...requesting, phase: 'waiting' },
      card: undefined,
      startable: true,
      note: { kind: 'starting', line: 'Starting…', inbox: false },
    },
    {
      name: 'a request answered and the daemon refused it',
      attempt: { ...requesting, phase: 'waiting' },
      card: refusal,
      startable: true,
      note: { kind: 'refused', line: refusal.title, inbox: true },
    },
    {
      name: 'a repeat refusal that folded into the card the builder already had',
      attempt: { ...requesting, phase: 'waiting', seen: '2026-10-29T09:59:00.000Z' },
      card: refusal,
      startable: true,
      note: { kind: 'refused', line: refusal.title, inbox: true },
    },
    {
      name: 'a request answered while only an old refusal is open',
      attempt: { ...requesting, phase: 'waiting', seen: refusal.updatedAt },
      card: refusal,
      startable: true,
      note: { kind: 'starting', line: 'Starting…', inbox: false },
    },
    {
      name: 'a request the daemon rejected at once',
      attempt: { phase: 'failed', reason: 'Task Alpha is already running' },
      card: undefined,
      startable: true,
      note: { kind: 'refused', line: 'Not started: Task Alpha is already running', inbox: false },
    },
    {
      name: 'an open refusal from before the page opened',
      attempt: undefined,
      card: refusal,
      startable: true,
      note: { kind: 'refused', line: refusal.title, inbox: true },
    },
    {
      name: 'a task that is no longer startable',
      attempt: requesting,
      card: refusal,
      startable: false,
      note: null,
    },
  ] as const)('says $note.kind for $name', ({ attempt, card, startable, note }) => {
    expect(startNote({ attempt, task, startable, card })).toEqual(note);
  });

  it('forgets a wait once the task has a run of its own', () => {
    const run = taskDto({ ...task, workstreamId: mintId('Workstream') });
    const attempt: StartAttempt = { ...requesting, phase: 'waiting' };
    expect(startNote({ attempt, task: run, startable: true, card: undefined })).toBeNull();
  });
});
