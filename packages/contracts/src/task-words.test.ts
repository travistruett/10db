import { describe, expect, it } from 'vitest';
import { TaskDto, TaskInput, TaskPatch, WorkstreamDto } from './entities';
import { GoalBriefTask } from './goals';

const input = { title: 'Add a table', acceptanceCriteria: ['x'], areas: ['api'] };

function messageFor(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => i.message).join('; ') ?? '';
}

describe('a task headline and why', () => {
  it('default to empty on a new task', () => {
    const config = TaskInput.parse(input);
    expect(config.headline).toBe('');
    expect(config.why).toBe('');
  });

  it('are taken on input, patch and a goal brief task', () => {
    const words = {
      headline: 'Odd files cannot freeze 10db',
      why: 'A FIFO could hang every lane.',
    };
    expect(TaskInput.parse({ ...input, ...words })).toMatchObject(words);
    expect(TaskPatch.parse(words)).toEqual(words);
    expect(GoalBriefTask.parse({ key: 'a', title: 'A', areas: ['api'], ...words })).toMatchObject(
      words,
    );
  });

  it('are on TaskDto, and WorkstreamDto carries the task headline', () => {
    expect(TaskDto.shape.headline.parse('')).toBe('');
    expect(TaskDto.shape.why.parse('')).toBe('');
    expect(WorkstreamDto.shape.taskHeadline.parse('Plain')).toBe('Plain');
  });

  it.each([
    ['headline', 'x'.repeat(81), /headline.*80/i],
    ['headline', 'two\nlines', /headline.*one line/i],
    ['why', 'x'.repeat(201), /why.*200/i],
    ['why', 'two\nlines', /why.*one line/i],
  ])('refuses a bad %s, naming the field', (field, value, message) => {
    expect(messageFor(TaskInput.safeParse({ ...input, [field]: value }))).toMatch(message);
    expect(messageFor(TaskPatch.safeParse({ [field]: value }))).toMatch(message);
    expect(
      messageFor(GoalBriefTask.safeParse({ key: 'a', title: 'A', areas: ['api'], [field]: value })),
    ).toMatch(message);
  });

  it('takes a headline of exactly 80 and a why of exactly 200', () => {
    const ok = { headline: 'h'.repeat(80), why: 'w'.repeat(200) };
    expect(TaskInput.safeParse({ ...input, ...ok }).success).toBe(true);
  });
});
