import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto, workstreamDto } from '../../test/fixtures';
import { isSpent } from './task-spent';

describe('isSpent', () => {
  it.each([
    { name: 'an open task whose run was cancelled', task: {}, state: 'CANCELLED', spent: true },
    {
      name: 'one still in a pass',
      task: { passId: mintId('Pass') },
      state: 'CANCELLED',
      spent: false,
    },
    { name: 'one with saved work', task: { keptWork: true }, state: 'CANCELLED', spent: false },
    { name: 'one whose run failed', task: {}, state: 'FAILED', spent: false },
    { name: 'a removed one', task: { status: 'cancelled' }, state: 'CANCELLED', spent: false },
    { name: 'one with no run', task: {}, state: null, spent: false },
  ] as const)('$name: $spent', ({ task, state, spent }) => {
    expect(isSpent(taskDto(task), state === null ? undefined : workstreamDto({ state }))).toBe(
      spent,
    );
  });
});
