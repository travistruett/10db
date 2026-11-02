import type { BatchState, WorkspaceMode } from '@10db/contracts';
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
      name: 'a project whose default is a separate copy, with no ticked task',
      project: projectViewDto({
        delivery: 'pull_request',
        prTitlePrefix: 'feat(app)',
        workspaceMode: 'worktree',
      }),
      expected: { kind: 'new_batch' },
    },
  ])('answers $name', ({ project, expected }) => {
    expect(sheetMode(project)).toEqual(expected);
  });

  it.each([
    {
      name: 'only separate copies, whatever the shared batch is doing',
      state: 'SHIPPING',
      placements: ['worktree', 'worktree'],
      expected: { kind: 'worktrees' },
    },
    {
      name: 'a mix, which follows the shared batch',
      state: 'OPEN',
      placements: ['shared', 'worktree'],
      expected: { kind: 'join', title },
    },
    {
      name: 'a mix with a shipping shared batch, which waits and says how to start the copies',
      state: 'SHIPPING',
      placements: ['worktree', 'shared'],
      expected: {
        kind: 'busy',
        title,
        reason:
          'Fix the login is shipping; start once it has shipped, or untick the Your folder tasks to start the separate copies now',
      },
    },
    {
      name: 'a mix with a cutting shared batch, which waits and says how to start the copies',
      state: 'CUTTING',
      placements: ['shared', 'worktree'],
      expected: {
        kind: 'busy',
        title,
        reason:
          'Fix the login is still cutting its branch; start when it is open, or untick the Your folder tasks to start the separate copies now',
      },
    },
    {
      name: 'only shared tasks with a busy shared batch, which has no copies to offer',
      state: 'SHIPPING',
      placements: ['shared'],
      expected: {
        kind: 'busy',
        title,
        reason: 'Fix the login is shipping; start once it has shipped',
      },
    },
    {
      name: 'only shared tasks',
      state: 'FAILED',
      placements: ['shared'],
      expected: { kind: 'fix', title },
    },
  ] satisfies {
    name: string;
    state: BatchState;
    placements: WorkspaceMode[];
    expected: SheetMode;
  }[])('answers for the ticked tasks: $name', ({ state, placements, expected }) => {
    expect(sheetMode(pr(state), placements)).toEqual(expected);
  });

  it('answers local for a local project whatever the tasks say', () => {
    expect(sheetMode(projectViewDto({ delivery: 'local' }), ['worktree'])).toEqual({
      kind: 'local',
    });
  });
});

describe('submitLabel', () => {
  it.each([
    { mode: { kind: 'local' }, count: 1, label: 'Start 1 task' },
    { mode: { kind: 'local' }, count: 2, label: 'Start 2 tasks' },
    { mode: { kind: 'new_batch' }, count: 2, label: 'Start a batch of 2 tasks' },
    { mode: { kind: 'join', title }, count: 1, label: 'Add 1 task to Fix the login' },
    { mode: { kind: 'fix', title }, count: 2, label: 'Add 2 fix tasks to Fix the login' },
    { mode: { kind: 'worktrees' }, count: 3, label: 'Start 3 tasks in separate copies' },
    { mode: { kind: 'worktrees' }, count: 1, label: 'Start 1 task in a separate copy' },
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

  it.each([
    {
      mode: { kind: 'new_batch' },
      count: 3,
      copies: 1,
      label: 'Start a batch of 2 tasks and start 1 task in a separate copy',
    },
    {
      mode: { kind: 'join', title },
      count: 3,
      copies: 2,
      label: 'Add 1 task to Fix the login and start 2 tasks in separate copies',
    },
    {
      mode: { kind: 'fix', title },
      count: 2,
      copies: 1,
      label: 'Add 1 fix task to Fix the login and start 1 task in a separate copy',
    },
    {
      mode: { kind: 'worktrees' },
      count: 2,
      copies: 2,
      label: 'Start 2 tasks in separate copies',
    },
  ] satisfies { mode: SheetMode; count: number; copies: number; label: string }[])(
    'with copies among the ticked, says "$label"',
    ({ mode, count, copies, label }) => {
      expect(submitLabel(mode, count, copies)).toBe(label);
    },
  );
});
