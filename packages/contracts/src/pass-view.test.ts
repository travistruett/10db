import { describe, expect, it } from 'vitest';
import {
  GoalPassPagesDto,
  mintId,
  PagesProposalDto,
  PassJoinRequest,
  PassOpenRequest,
  PassRename,
  PassStartDto,
  PassTurnWithFilesDto,
  PassViewDto,
  SessionActivityData,
  TurnActivityDto,
} from './index';

const AT = '2026-11-09T12:00:00.000Z';

describe("the Workbench's start, join and rename", () => {
  it('reads what Start Pass says: a page with changed files, the files elsewhere, and what the project lacks', () => {
    const start = {
      pages: [
        {
          area: 'settings',
          route: '/settings',
          lastChangedAt: AT,
          uncommitted: 3,
          heldBy: null,
        },
        {
          area: 'people',
          route: null,
          lastChangedAt: null,
          uncommitted: 0,
          heldBy: { taskId: mintId('Task'), title: 'People table' },
        },
      ],
      otherUncommitted: 12,
      lacks: [
        { kind: 'ahead_of_base', count: 4, branch: 'build' },
        { kind: 'docker_off', count: null, branch: null },
      ],
      refusal: null,
    };
    expect(PassStartDto.parse(start)).toEqual(start);
    expect(
      PassStartDto.safeParse({ ...start, lacks: [{ kind: 'no_gate', count: null, branch: null }] })
        .success,
    ).toBe(false);
  });

  it.each([
    { name: 'pages alone', body: { name: 'Polish', taskIds: [], pages: ['settings'] }, ok: true },
    { name: 'tasks alone', body: { name: 'Polish', taskIds: [mintId('Task')] }, ok: true },
    {
      name: 'pages for a goal',
      body: { name: 'Polish', taskIds: [], pages: ['settings'], goalId: mintId('Goal') },
      ok: true,
    },
    {
      name: 'neither pages nor tasks',
      body: { name: 'Polish', taskIds: [], pages: [] },
      ok: false,
    },
    {
      name: 'a seventh page',
      body: {
        name: 'Polish',
        taskIds: [mintId('Task'), mintId('Task')],
        pages: ['a', 'b', 'c', 'd', 'e'],
      },
      ok: false,
    },
  ])('opens a pass from $name: $ok', ({ body, ok }) => {
    expect(PassOpenRequest.safeParse(body).success).toBe(ok);
  });

  it('adds pages and tasks to an open pass, and renames it to one line', () => {
    const join = { pages: ['billing'], taskIds: [mintId('Task')], firstMessage: null };
    expect(PassJoinRequest.parse(join)).toEqual(join);
    expect(PassJoinRequest.safeParse({ ...join, pages: [], taskIds: [] }).success).toBe(false);
    expect(PassRename.parse({ name: 'Settings pass' })).toEqual({ name: 'Settings pass' });
    expect(PassRename.safeParse({ name: 'two\nlines' }).success).toBe(false);
  });

  it('reads the proposed page areas, with the ones skipped and why, and the pages a goal touched', () => {
    const proposal = {
      pages: [
        {
          name: 'settings',
          globs: ['src/settings/**'],
          role: 'page',
          route: '/settings',
          reason: 'The settings screen',
        },
      ],
      skipped: [{ name: 'people', reason: 'An area of that name already exists' }],
    };
    expect(PagesProposalDto.parse(proposal)).toEqual(proposal);
    const pages = { pages: ['settings'], fromTasks: [mintId('Task')] };
    expect(GoalPassPagesDto.parse(pages)).toEqual(pages);
  });
});

describe("a pass lane's activity and turns", () => {
  const turnId = mintId('PassTurn');

  it('reads a pass lane activity naming its tool, target and the files its turn touched', () => {
    const data = {
      workstreamId: mintId('Workstream'),
      kind: 'tool_use',
      summary: 'Edit src/settings/page.tsx',
      tool: { name: 'Edit', target: 'src/settings/page.tsx' },
      turn: { id: turnId, filesTouched: ['src/settings/page.tsx'] },
    };
    expect(SessionActivityData.parse(data)).toEqual(data);
    // A lane outside a pass has no turn; one writing text has no tool.
    expect(SessionActivityData.parse({ ...data, tool: null, turn: null })).toMatchObject({
      tool: null,
      turn: null,
    });
    expect(
      SessionActivityData.safeParse({ ...data, turn: { id: mintId('Task'), filesTouched: [] } })
        .success,
    ).toBe(false);
  });

  it('reads a page whose turn says what the agent is doing now', () => {
    const view = {
      pass: {
        id: mintId('Pass'),
        projectId: mintId('Project'),
        name: 'Polish',
        state: 'OPEN',
        batchId: mintId('Batch'),
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        openedAt: AT,
        createdAt: AT,
        updatedAt: AT,
      },
      pages: [
        {
          taskId: mintId('Task'),
          title: 'Settings: UI work',
          area: 'settings',
          route: '/settings',
          workstreamId: mintId('Workstream'),
          state: 'RUNNING',
          nextActionKind: 'start',
          spokenTo: true,
          turn: {
            id: turnId,
            seq: 1,
            startedAt: AT,
            endedAt: null,
            readyAt: null,
            activity: {
              tool: 'Edit',
              target: 'src/settings/page.tsx',
              filesTouched: ['src/settings/page.tsx'],
              at: AT,
            },
          },
          pausedUntil: null,
          failure: null,
          signOff: 'none',
        },
      ],
      turns: [],
    };
    expect(PassViewDto.parse(view)).toEqual(view);
  });

  it("reads a task's turns with their files, and a turn's activity for Show Log", () => {
    const turn = {
      id: turnId,
      taskId: mintId('Task'),
      workstreamId: mintId('Workstream'),
      sessionId: null,
      seq: 2,
      messageId: null,
      startedAt: AT,
      endedAt: AT,
      ending: 'ready',
      settledAt: AT,
      keptSha: 'b'.repeat(40),
      keptBaseSha: 'a'.repeat(40),
      sharedSeq: null,
      check: 'none',
      readyAt: AT,
      openedAt: null,
      answeredAt: null,
      files: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
    };
    expect(PassTurnWithFilesDto.parse(turn)).toEqual(turn);
    expect(PassTurnWithFilesDto.safeParse({ ...turn, files: undefined }).success).toBe(false);
    const row = { at: AT, kind: 'tool_use', summary: 'Edit src/settings/page.tsx' };
    expect(TurnActivityDto.parse(row)).toEqual(row);
  });
});
