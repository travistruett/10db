import { describe, expect, it } from 'vitest';
import { ActivityPageQuery, ActivityRow, NoticePostedData } from './activity';
import { mintId } from './ids';

const projectId = mintId('Project');
const taskId = mintId('Task');

describe('activity page query', () => {
  it.each([
    ['nothing set', {}, { pageSize: 50 }],
    ['a cursor', { after: '12' }, { after: 12, pageSize: 50 }],
  ])('accepts %s', (_name, input, expected) => {
    const parsed = ActivityPageQuery.safeParse(input);
    expect(parsed.success && parsed.data).toEqual(expected);
  });

  it.each([
    ['a zero cursor', { after: '0' }],
    ['a cursor that is not a number', { after: 'x' }],
    ['a page size over the cap', { pageSize: '101' }],
    ['a blank search', { q: '  ' }],
    ['project and task together', { project: projectId, task: taskId }],
    ['a key the query does not know', { recent: '1' }],
  ])('refuses %s', (_name, input) => {
    expect(ActivityPageQuery.safeParse(input).success).toBe(false);
  });

  it('says why project and task together are refused', () => {
    const parsed = ActivityPageQuery.safeParse({ project: projectId, task: taskId });
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe('project or task, not both');
  });
});

describe('notice posted data', () => {
  const data = { projectId, taskId: null, key: 'k', tone: 'info', line: 'one line', body: '' };

  it('accepts a notice', () => {
    expect(NoticePostedData.safeParse(data).success).toBe(true);
  });

  it.each([
    ['a tone that asks something', { tone: 'error' }],
    ['a line over its limit', { line: 'x'.repeat(501) }],
  ])('refuses %s', (_name, patch) => {
    expect(NoticePostedData.safeParse({ ...data, ...patch }).success).toBe(false);
  });
});

describe('activity row', () => {
  it('refuses a count of zero', () => {
    const at = '2026-11-17T10:00:00.000Z';
    const row = {
      projectId,
      taskId: null,
      key: 'k',
      tone: 'info',
      line: 'l',
      body: '',
      seq: 1,
      at,
      firstAt: at,
    };
    expect(ActivityRow.safeParse({ ...row, count: 1 }).success).toBe(true);
    expect(ActivityRow.safeParse({ ...row, count: 0 }).success).toBe(false);
  });
});
