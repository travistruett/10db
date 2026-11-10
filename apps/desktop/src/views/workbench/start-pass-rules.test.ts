import {
  mintId,
  PASS_PAGE_CAP_MAX,
  type AreaDef,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import {
  blockedReason,
  joinableTasks,
  openRequest,
  pageCap,
  passName,
  sharedOverlaps,
  type PickTicks,
} from './start-pass-rules';

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'forms', globs: ['src/**/form.tsx'], role: 'page' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
  { name: 'repo', globs: ['**'], catchAll: true },
];

describe('joinableTasks', () => {
  const open = { status: 'open', boardStatus: 'ready', workspaceMode: 'shared' } as const;
  it.each<{ name: string; task: Partial<TaskDto>; joins: boolean }>([
    { name: 'an open task naming a page', task: { ...open, areas: ['settings'] }, joins: true },
    {
      name: 'a parked one',
      task: { ...open, boardStatus: 'backlog', areas: ['settings'] },
      joins: true,
    },
    {
      name: 'one holding kept work',
      task: { ...open, areas: ['people'], keptWork: true },
      joins: true,
    },
    { name: 'one naming only a shared area', task: { ...open, areas: ['src'] }, joins: false },
    {
      name: 'a running one',
      task: { ...open, boardStatus: 'in_progress', areas: ['settings'] },
      joins: false,
    },
    {
      name: 'a shipped one',
      task: { ...open, boardStatus: 'in_review', areas: ['settings'] },
      joins: false,
    },
    { name: 'a done one', task: { ...open, status: 'done', areas: ['settings'] }, joins: false },
    {
      name: 'one in a separate copy',
      task: { ...open, workspaceMode: 'worktree', areas: ['settings'] },
      joins: false,
    },
    {
      name: 'one already in a pass',
      task: { ...open, areas: ['settings'], passId: mintId('Pass') },
      joins: false,
    },
  ])('$name joins: $joins', ({ task, joins }) => {
    const dto = taskDto({ title: 'Tighten the form', ...task });
    expect(joinableTasks([dto], areas).map((t) => t.taskId)).toEqual(joins ? [dto.id] : []);
  });

  it('names a task by its headline, else its title, and holds its page areas', () => {
    const titled = taskDto({
      ...open,
      title: 'feat: form',
      headline: '',
      areas: ['settings', 'src'],
    });
    const headed = taskDto({
      ...open,
      title: 'feat: list',
      headline: 'Lists breathe',
      areas: ['people'],
    });
    expect(joinableTasks([titled, headed], areas)).toEqual([
      { taskId: titled.id, title: 'feat: form', pages: ['settings'] },
      { taskId: headed.id, title: 'Lists breathe', pages: ['people'] },
    ]);
  });
});

describe('blockedReason', () => {
  const task = (pages: string[]) => ({ taskId: mintId('Task'), title: 'Tighten it', pages });
  const none: PickTicks = { pages: [], tasks: [] };
  it.each<{ name: string; row: { pages: string[] }; ticks: PickTicks; reason: string | null }>([
    { name: 'nothing ticked', row: { pages: ['settings'] }, ticks: none, reason: null },
    {
      name: 'a page that shares no file with a ticked one',
      row: { pages: ['people'] },
      ticks: { pages: ['settings'], tasks: [] },
      reason: null,
    },
    {
      name: 'a page whose files a ticked page can share, naming the globs',
      row: { pages: ['forms'] },
      ticks: { pages: ['settings'], tasks: [] },
      reason:
        'settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
    },
    {
      name: 'a page a ticked task holds',
      row: { pages: ['settings'] },
      ticks: { pages: [], tasks: [task(['settings'])] },
      reason: 'Tighten it works on settings',
    },
    {
      name: 'a task on a ticked page',
      row: { pages: ['people'] },
      ticks: { pages: ['people'], tasks: [] },
      reason: 'people is ticked',
    },
  ])('$name', ({ row, ticks, reason }) => {
    expect(blockedReason(row, ticks, areas)).toBe(reason);
  });

  it('refuses another row once the pass is full', () => {
    const full: PickTicks = {
      pages: Array.from({ length: PASS_PAGE_CAP_MAX }, (_, n) => `Page ${String(n)}`),
      tasks: [],
    };
    expect(blockedReason({ pages: ['people'] }, full, areas)).toBe(
      `A pass holds at most ${String(PASS_PAGE_CAP_MAX)} pages`,
    );
  });
});

describe('passName', () => {
  it.each([
    [['settings'], 'settings pass'],
    [['settings', 'people'], 'settings and people pass'],
    [['settings', 'people', 'billing'], 'settings, people and billing pass'],
    [['settings', 'people', 'billing', 'home'], 'settings, people and 2 more pass'],
  ])('%j is %s', (pages, name) => {
    expect(passName(pages)).toBe(name);
  });
});

describe('pageCap', () => {
  it.each([
    [1, 4],
    [4, 4],
    [5, 5],
    [6, 6],
  ])('%i ticked holds %i', (ticked, cap) => {
    expect(pageCap(ticked)).toBe(cap);
  });
});

describe('openRequest', () => {
  const taskId: TaskId = mintId('Task');
  it('opens the ticked pages and tasks, named by their pages, with the message only when written', () => {
    const ticks: PickTicks = {
      pages: ['settings'],
      tasks: [{ taskId, title: 'Tighten it', pages: ['people'] }],
    };
    expect(openRequest(ticks, '  these feel cramped ', null)).toEqual({
      name: 'settings and people pass',
      pages: ['settings'],
      taskIds: [taskId],
      pageCap: 4,
      firstMessage: 'these feel cramped',
    });
    const goalId = mintId('Goal');
    expect(openRequest({ pages: ['settings'], tasks: [] }, ' ', goalId)).toEqual({
      name: 'settings pass',
      pages: ['settings'],
      taskIds: [],
      pageCap: 4,
      goalId,
    });
  });
});

describe('sharedOverlaps', () => {
  it('names each ticked page that a shared area can also match, once per pair', () => {
    expect(sharedOverlaps(['settings', 'people', 'forms'], areas)).toEqual([
      { page: 'settings', shared: 'src' },
      { page: 'people', shared: 'src' },
      { page: 'forms', shared: 'src' },
    ]);
    expect(sharedOverlaps([], areas)).toEqual([]);
  });

  it('leaves out a page no shared area reaches', () => {
    const apart: AreaDef[] = [
      { name: 'settings', globs: ['app/settings/**'], role: 'page' },
      { name: 'src', globs: ['src/**'], role: 'shared' },
    ];
    expect(sharedOverlaps(['settings'], apart)).toEqual([]);
  });
});
