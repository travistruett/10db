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
  goalReadyForPass,
  joinableTasks,
  openRequest,
  pageCap,
  passName,
  tickedWords,
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
  it('names a ticked page by its label, which is not its name', () => {
    const labelled: AreaDef[] = [
      { name: 'shape', globs: ['src/shape/**'], role: 'page', label: 'Plan' },
      { name: 'forms', globs: ['src/forms/**'], role: 'page' },
    ];
    expect(blockedReason({ pages: ['shape'] }, { pages: ['shape'], tasks: [] }, labelled)).toBe(
      'Plan is ticked',
    );
  });

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
        'Settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
    },
    {
      name: 'a page a ticked task holds',
      row: { pages: ['settings'] },
      ticks: { pages: [], tasks: [task(['settings'])] },
      reason: 'Tighten it works on Settings',
    },
    {
      name: 'a task on a ticked page',
      row: { pages: ['people'] },
      ticks: { pages: ['people'], tasks: [] },
      reason: 'People is ticked',
    },
  ])('$name', ({ row, ticks, reason }) => {
    expect(blockedReason(row, ticks, areas)).toBe(reason);
  });

  it.each<{ name: string; row: { pages: string[] }; inPass: string[]; reason: string | null }>([
    {
      name: 'a page beside the pass',
      row: { pages: ['people'] },
      inPass: ['settings'],
      reason: null,
    },
    {
      name: 'a page the pass holds',
      row: { pages: ['settings'] },
      inPass: ['settings'],
      reason: 'Settings is already open',
    },
    {
      name: 'a page that can share a file with one the pass holds',
      row: { pages: ['forms'] },
      inPass: ['settings'],
      reason:
        'Settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
    },
    {
      name: 'any page once the pass and the ticks fill it',
      row: { pages: ['people'] },
      inPass: ['a', 'b', 'c', 'd', 'e'],
      reason: `At most ${String(PASS_PAGE_CAP_MAX)} pages can be open at once`,
    },
  ])('beside an open pass, $name', ({ row, inPass, reason }) => {
    const ticks: PickTicks = { pages: inPass.length === 5 ? ['f'] : [], tasks: [] };
    expect(blockedReason(row, ticks, areas, inPass)).toBe(reason);
  });

  it('refuses another row once the pass is full', () => {
    const full: PickTicks = {
      pages: Array.from({ length: PASS_PAGE_CAP_MAX }, (_, n) => `Page ${String(n)}`),
      tasks: [],
    };
    expect(blockedReason({ pages: ['people'] }, full, areas)).toBe(
      `At most ${String(PASS_PAGE_CAP_MAX)} pages can be open at once`,
    );
  });
});

describe('passName', () => {
  it.each([
    [['settings'], 'settings'],
    [['Settings', 'People'], 'Settings and People'],
    [['settings', 'people', 'billing'], 'settings, people and billing'],
    [['settings', 'people', 'billing', 'home'], 'settings, people and 2 more'],
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
  it('opens the ticked pages and tasks, named by their pages, with no first message', () => {
    const ticks: PickTicks = {
      pages: ['settings'],
      tasks: [{ taskId, title: 'Tighten it', pages: ['people'] }],
    };
    expect(openRequest(ticks, null, [])).toEqual({
      name: 'Settings and People',
      pages: ['settings'],
      taskIds: [taskId],
      pageCap: 4,
    });
    const goalId = mintId('Goal');
    expect(openRequest({ pages: ['settings'], tasks: [] }, goalId, [])).toEqual({
      name: 'Settings',
      pages: ['settings'],
      taskIds: [],
      pageCap: 4,
      goalId,
    });
  });
});

describe('openRequest names the pass by labels', () => {
  const labelled: AreaDef[] = [
    { name: 'shape', globs: ['src/shape/**'], role: 'page', label: 'Plan' },
    { name: 'people', globs: ['src/people/**'], role: 'page' },
  ];
  it("uses a page label for a ticked page and for a ticked task's first page, else the capitalised name", () => {
    const ticks: PickTicks = {
      pages: ['shape'],
      tasks: [{ taskId: mintId('Task'), title: 'Tighten it', pages: ['people'] }],
    };
    expect(openRequest(ticks, null, labelled).name).toBe('Plan and People');
  });
});

describe('goalReadyForPass', () => {
  const ui = (boardStatus: TaskDto['boardStatus'], more: Partial<TaskDto> = {}) =>
    taskDto({ areas: ['settings'], boardStatus, ...more });
  it.each<{ name: string; tasks: TaskDto[]; ready: boolean }>([
    { name: 'every UI task done or in review', tasks: [ui('done'), ui('in_review')], ready: true },
    { name: 'all but one', tasks: [ui('done'), ui('in_review'), ui('in_progress')], ready: true },
    { name: 'two still to go', tasks: [ui('done'), ui('ready'), ui('in_progress')], ready: false },
    {
      name: 'a task on shared code still running, which is not UI work',
      tasks: [ui('done'), ui('in_progress', { areas: ['src'] }), ui('ready', { areas: ['src'] })],
      ready: true,
    },
    {
      name: 'a cancelled UI task, which counts for nothing',
      tasks: [ui('done'), ui('ready'), ui('backlog', { status: 'cancelled' })],
      ready: true,
    },
    { name: 'no UI task', tasks: [ui('done', { areas: ['src'] })], ready: false },
  ])('$name: $ready', ({ tasks, ready }) => {
    expect(goalReadyForPass(tasks, areas)).toBe(ready);
  });
});

describe('tickedWords', () => {
  const task = (title: string) => ({ taskId: mintId('Task'), title, pages: ['people'] });
  it.each<{ name: string; ticks: PickTicks; says: string }>([
    { name: 'nothing', ticks: { pages: [], tasks: [] }, says: '' },
    { name: 'one page', ticks: { pages: ['settings'], tasks: [] }, says: '1 page' },
    { name: 'two pages', ticks: { pages: ['settings', 'people'], tasks: [] }, says: '2 pages' },
    { name: 'one task', ticks: { pages: [], tasks: [task('a')] }, says: '1 task' },
    {
      name: 'pages and tasks, pages first',
      ticks: { pages: ['settings', 'people'], tasks: [task('a')] },
      says: '2 pages \u00b7 1 task',
    },
    {
      name: 'several tasks',
      ticks: { pages: [], tasks: [task('a'), task('b')] },
      says: '2 tasks',
    },
  ])('says $name', ({ ticks, says }) => {
    expect(tickedWords(ticks)).toBe(says);
  });
});
