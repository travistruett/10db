import { mintId, type WorkstreamDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, workstreamDto } from '../../../test/fixtures';
import { abandonNote } from './abandon-note';

const batch = batchDto();
const member = (taskTitle: string, state: WorkstreamDto['state'], extra = {}) =>
  workstreamDto({ batchId: batch.id, projectId: batch.projectId, taskTitle, state, ...extra });

describe('abandonNote', () => {
  it('names the one unfinished task it cancels', () => {
    expect(abandonNote(batch, [member('Alpha', 'QUEUED'), member('Beta', 'DONE')])).toEqual({
      refusal: null,
      line: 'Abandon keeps the branch and cancels its unfinished task.',
    });
  });

  it('counts the unfinished tasks when several share the branch', () => {
    const note = abandonNote(batch, [
      member('Alpha', 'QUEUED'),
      member('Beta', 'WAITING_HUMAN'),
      member('Gamma', 'FAILED'),
      member('Delta', 'DONE'),
    ]);
    expect(note.line).toBe('Abandon keeps the branch and cancels its 2 unfinished tasks.');
  });

  it('says nothing is cancelled when every task is done', () => {
    expect(abandonNote(batch, [member('Alpha', 'DONE')]).line).toBe(
      'Abandon keeps the branch and closes it without shipping.',
    );
  });

  it('counts a retried task once, by its latest run, and ignores other batches', () => {
    const first = member('Alpha', 'FAILED');
    const retried = workstreamDto({ ...first, id: workstreamDto().id, state: 'QUEUED' });
    const elsewhere = workstreamDto({ taskTitle: 'Other', state: 'QUEUED' });
    expect(abandonNote(batch, [first, retried, elsewhere]).line).toBe(
      'Abandon keeps the branch and cancels its unfinished task.',
    );
  });

  it.each([
    ['running', member('Alpha', 'RUNNING')],
    ['starting', member('Alpha', 'STARTING')],
    ['checking', member('Alpha', 'VERIFYING')],
    ['handing off', member('Alpha', 'HANDING_OFF')],
    ['taken over', member('Alpha', 'TAKEN_OVER')],
    [
      'waiting with a live session',
      member('Alpha', 'WAITING_HUMAN', { currentSessionId: mintId('Session') }),
    ],
  ])('is blocked while a task is %s, because the daemon refuses', (_name, live) => {
    expect(abandonNote(batch, [live, member('Beta', 'QUEUED')])).toEqual({
      refusal: 'Alpha is running: cancel it in Factory first.',
      line: 'Alpha is running: cancel it in Factory first. Abandon keeps the branch and cancels its 2 unfinished tasks.',
    });
  });

  it('is not blocked by a task waiting with no session', () => {
    expect(abandonNote(batch, [member('Alpha', 'WAITING_HUMAN')]).refusal).toBeNull();
  });

  it('names every running task', () => {
    const note = abandonNote(batch, [member('Alpha', 'RUNNING'), member('Beta', 'VERIFYING')]);
    expect(note.refusal).toBe('Alpha and Beta are running: cancel them in Factory first.');
    expect(note.line).toBe(
      'Alpha and Beta are running: cancel them in Factory first. Abandon keeps the branch and cancels its 2 unfinished tasks.',
    );
  });
});
