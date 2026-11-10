import { describe, expect, it } from 'vitest';
import { mintId, type PassSharedChangeDto, type PassTurnDto } from '@10db/contracts';
import { pictureRoutes, takesPictures, turnChangedSomething } from './picture-routes';

// Workbench spec §10 "Which pages" and "How": a task's pictures are the routes of the page areas it
// names, in each viewport and theme; a turn that changed nothing under a page or shared area is not shot.

const AREAS = [
  { name: 'people', globs: ['src/people/**'], role: 'page' as const, route: '/people' },
  { name: 'person', globs: ['src/person/**'], role: 'page' as const, route: '/people/[id]' },
  { name: 'org', globs: ['src/org/**'], role: 'page' as const, route: '/org/:id' },
  {
    name: 'settings',
    globs: ['src/settings/**'],
    role: 'page' as const,
    route: '/settings?tab=all',
  },
  { name: 'nameless', globs: ['src/nameless/**'], role: 'page' as const },
  { name: 'ui', globs: ['src/ui/**'], role: 'shared' as const },
];
const project = {
  appUrl: 'http://localhost:8800',
  areas: AREAS,
  screens: {
    viewports: [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ],
    themes: ['default' as const],
  },
};

describe('pictureRoutes', () => {
  it('shoots each loadable route the task names in each viewport and theme', () => {
    expect(
      pictureRoutes(project, { areas: ['people', 'person', 'org', 'settings', 'nameless', 'ui'] }),
    ).toEqual([
      { route: '/people', viewport: { width: 1440, height: 900 }, theme: 'default' },
      { route: '/people', viewport: { width: 390, height: 844 }, theme: 'default' },
      { route: '/settings?tab=all', viewport: { width: 1440, height: 900 }, theme: 'default' },
      { route: '/settings?tab=all', viewport: { width: 390, height: 844 }, theme: 'default' },
    ]);
  });

  it('adds the routes the agent reported, once each, after the page areas', () => {
    expect(
      pictureRoutes(
        { ...project, screens: { ...project.screens, viewports: [{ width: 1440, height: 900 }] } },
        { areas: ['people'] },
        ['/people/42', '/people', '/people/42'],
      ).map((t) => t.route),
    ).toEqual(['/people', '/people/42']);
    expect(pictureRoutes({ ...project, appUrl: null }, { areas: [] }, ['/people/42'])).toEqual([]);
  });

  it('shoots nothing for a project with no app address, or a task with no page route', () => {
    expect(pictureRoutes({ ...project, appUrl: null }, { areas: ['people'] })).toEqual([]);
    expect(pictureRoutes(project, { areas: ['ui', 'person'] })).toEqual([]);
  });
});

describe('takesPictures', () => {
  it.each([
    {
      name: 'a pass page',
      task: { areas: ['ui'], passId: mintId('Pass'), workspaceMode: 'shared' as const },
      takes: true,
    },
    {
      name: 'a Your-folder task naming a page',
      task: { areas: ['people'], passId: null, workspaceMode: 'shared' as const },
      takes: true,
    },
    {
      name: 'a Your-folder task naming shared code only',
      task: { areas: ['ui'], passId: null, workspaceMode: 'shared' as const },
      takes: false,
    },
    {
      name: 'a Your-folder task naming shared code only that reported a route',
      task: { areas: ['ui'], passId: null, workspaceMode: 'shared' as const },
      reported: ['/people/42'],
      takes: true,
    },
    {
      name: 'a task in a separate copy',
      task: { areas: ['people'], passId: null, workspaceMode: 'worktree' as const },
      takes: false,
    },
  ])('$name', ({ task, reported = [], takes }) => {
    expect(takesPictures(project, task, reported)).toBe(takes);
  });
});

const turn = (over: Partial<PassTurnDto> = {}): PassTurnDto => ({
  id: mintId('PassTurn'),
  taskId,
  workstreamId: mintId('Workstream'),
  sessionId: null,
  seq: 2,
  messageId: null,
  startedAt: '2026-11-10T12:00:00.000Z',
  endedAt: '2026-11-10T12:01:00.000Z',
  ending: 'ready',
  settledAt: null,
  keptSha: null,
  keptBaseSha: null,
  sharedSeq: null,
  check: 'none',
  readyAt: null,
  openedAt: null,
  answeredAt: null,
  ...over,
});
const taskId = mintId('Task');
const change = (seq: number, by = taskId): PassSharedChangeDto => ({
  passId: mintId('Pass'),
  seq,
  taskId: by,
  sha: 'c'.repeat(40),
  paths: ['src/ui/button.tsx'],
  blobs: {},
  dirtyKept: false,
  landedSha: null,
  droppedBy: null,
  dropOf: null,
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
});
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('turnChangedSomething', () => {
  it.each([
    {
      name: 'a first turn with a kept commit',
      now: turn({ keptSha: A }),
      previous: undefined,
      changes: [],
      changed: true,
    },
    {
      name: 'a new kept commit',
      now: turn({ keptSha: B }),
      previous: turn({ keptSha: A }),
      changes: [],
      changed: true,
    },
    {
      name: 'the same kept commit',
      now: turn({ keptSha: A }),
      previous: turn({ keptSha: A }),
      changes: [],
      changed: false,
    },
    { name: 'nothing kept yet', now: turn(), previous: undefined, changes: [], changed: false },
    {
      name: 'a shared change of the task held in this turn',
      now: turn({ keptSha: A, sharedSeq: 3 }),
      previous: turn({ keptSha: A, sharedSeq: 1 }),
      changes: [change(2)],
      changed: true,
    },
    {
      name: "a shared change of the task's earlier turn",
      now: turn({ keptSha: A, sharedSeq: 3 }),
      previous: turn({ keptSha: A, sharedSeq: 2 }),
      changes: [change(2)],
      changed: false,
    },
    {
      name: "another task's shared change in this turn",
      now: turn({ keptSha: A, sharedSeq: 3 }),
      previous: turn({ keptSha: A, sharedSeq: 1 }),
      changes: [change(2, mintId('Task'))],
      changed: false,
    },
  ])('$name', ({ now, previous, changes, changed }) => {
    expect(turnChangedSomething(now, previous, changes)).toBe(changed);
  });
});
