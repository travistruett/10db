import { describe, expect, it } from 'vitest';
import { FakeTaskRefs } from './fake-task-refs';

describe('FakeTaskRefs', () => {
  it('resolves $task:<title> to the id a tool result showed for that title', () => {
    const refs = new FakeTaskRefs();
    refs.learn(
      JSON.stringify({ kind: 'task', taskId: 'tsk_a', title: 'Retry login', column: 'Ready' }),
    );
    refs.learn(JSON.stringify([{ id: 'tsk_b', title: 'The builder’s task' }]));
    expect(refs.resolve({ taskId: '$task:Retry login' })).toEqual({ taskId: 'tsk_a' });
    expect(
      refs.resolve({ taskId: '$task:The builder’s task', nested: { ids: ['$task:Retry login'] } }),
    ).toEqual({
      taskId: 'tsk_b',
      nested: { ids: ['tsk_a'] },
    });
  });
  it('leaves a reference it has not seen, and every other value, as written', () => {
    const refs = new FakeTaskRefs();
    refs.learn('not json');
    expect(refs.resolve({ taskId: '$task:Unknown', title: 'plain', n: 3, ok: true })).toEqual({
      taskId: '$task:Unknown',
      title: 'plain',
      n: 3,
      ok: true,
    });
  });
});
