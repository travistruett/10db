import type { BatchState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, projectViewDto } from '../../../test/fixtures';
import { sheetMode, submitLabel, type SheetMode } from './sheet-mode';

const title = 'Fix the login';
const pr = (state: BatchState | null) =>
  projectViewDto({
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    currentBatch: state === null ? null : batchDto({ title, state }),
  });

describe('sheetMode', () => {
  it.each([
    {
      name: 'a local project',
      project: projectViewDto({ delivery: 'local' }),
      expected: { kind: 'local' },
    },
    { name: 'no batch yet', project: pr(null), expected: { kind: 'new_batch' } },
    { name: 'a shipped batch', project: pr('SHIPPED'), expected: { kind: 'new_batch' } },
    { name: 'a closed batch', project: pr('CLOSED'), expected: { kind: 'new_batch' } },
    { name: 'an abandoned batch', project: pr('ABANDONED'), expected: { kind: 'new_batch' } },
    { name: 'an open batch', project: pr('OPEN'), expected: { kind: 'join', title } },
    { name: 'a failed batch', project: pr('FAILED'), expected: { kind: 'fix', title } },
    {
      name: 'a batch cutting its branch',
      project: pr('CUTTING'),
      expected: {
        kind: 'busy',
        title,
        reason: 'Fix the login is still cutting its branch; start when it is open',
      },
    },
    {
      name: 'a shipping batch',
      project: pr('SHIPPING'),
      expected: {
        kind: 'busy',
        title,
        reason: 'Fix the login is shipping; start once it has shipped',
      },
    },
    {
      name: 'worktree mode always starts new work',
      project: projectViewDto({
        delivery: 'pull_request',
        prTitlePrefix: 'feat(app)',
        workspaceMode: 'worktree',
        currentBatch: batchDto({ title, state: 'SHIPPING' }),
      }),
      expected: { kind: 'worktrees' },
    },
  ])('answers $name', ({ project, expected }) => {
    expect(sheetMode(project)).toEqual(expected);
  });
});

describe('submitLabel', () => {
  it.each([
    { mode: { kind: 'local' }, count: 1, label: 'Start 1 task' },
    { mode: { kind: 'local' }, count: 2, label: 'Start 2 tasks' },
    { mode: { kind: 'new_batch' }, count: 2, label: 'Start a batch of 2 tasks' },
    { mode: { kind: 'join', title }, count: 1, label: 'Add 1 task to Fix the login' },
    { mode: { kind: 'fix', title }, count: 2, label: 'Add 2 fix tasks to Fix the login' },
    { mode: { kind: 'worktrees' }, count: 3, label: 'Start 3 tasks in worktrees' },
    {
      mode: { kind: 'busy', title, reason: 'Fix the login is shipping; start once it has shipped' },
      count: 1,
      label: 'Add 1 task to Fix the login',
    },
  ] satisfies { mode: SheetMode; count: number; label: string }[])(
    'says "$label"',
    ({ mode, count, label }) => {
      expect(submitLabel(mode, count)).toBe(label);
    },
  );
});
