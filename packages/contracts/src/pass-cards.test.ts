import { describe, expect, it } from 'vitest';
import { mintId, PassCardDetail, PassCloseAnswerDto, TakeOutRequest } from './index';

// Workbench spec §5.4, §7.2, §8.4: the cards a pass raises are told apart by `detail.kind`, and a
// close answers either that it is closing or the lists again.

const passId = mintId('Pass');
const taskId = mintId('Task');

describe("a pass card's detail", () => {
  it.each([
    {
      name: 'the shared question',
      detail: {
        kind: 'shared_ask',
        passId,
        taskId,
        workstreamId: mintId('Workstream'),
        area: 'src',
        others: [
          {
            taskId: mintId('Task'),
            title: 'Settings',
            paths: ['src/Button.tsx'],
            at: '2026-11-09T12:00:00.000Z',
            holdsNow: false,
          },
        ],
      },
    },
    {
      name: "D8's moved branch",
      detail: {
        kind: 'pass_branch_moved',
        passId,
        returnBranch: 'build',
        passBranch: '10db/polish-abc',
        reason: 'moved',
        mergeCommand: 'git merge 10db/polish-abc',
      },
    },
    {
      name: "D22's Move",
      detail: {
        kind: 'pass_move',
        passId,
        returnBranch: 'build',
        base: 'main',
        reason: 'drift',
        prUrl: null,
      },
    },
    {
      name: "D24's Retarget",
      detail: { kind: 'pass_retarget', passId, stackedOn: mintId('Pass'), base: 'main' },
    },
    {
      name: 'a failed close gate',
      detail: {
        kind: 'pass_gate_failed',
        passId,
        where: 'scratch',
        logPath: null,
        tasks: [{ taskId, title: 'People' }],
      },
    },
    {
      name: 'Move to a Separate Copy',
      detail: {
        kind: 'pass_move_to_copy',
        passId,
        taskId,
        workstreamId: mintId('Workstream'),
        hazard: 'migrations',
      },
    },
    {
      name: 'the follow-on after a merge while open',
      detail: {
        kind: 'pass_follow_on',
        passId,
        followOnPassId: null,
        prUrl: null,
        carried: [taskId],
      },
    },
  ])('reads $name', ({ detail }) => {
    expect(PassCardDetail.parse(detail)).toEqual(detail);
  });

  it('refuses a kind no pass card has, and a known kind missing its pass', () => {
    expect(PassCardDetail.safeParse({ kind: 'pass_abandon_x', passId }).success).toBe(false);
    expect(PassCardDetail.safeParse({ kind: 'pass_retarget', base: 'main' }).success).toBe(false);
  });
});

describe("a close's answer and a take-out's request", () => {
  it('answers closing with the pass, or the lists again with what changed', () => {
    const changed = {
      outcome: 'changed',
      preview: {
        token: 't2',
        unfinished: [{ taskId, title: 'People', working: false, sharedUnlanded: [] }],
        unowned: [{ path: 'README.md', added: 4, removed: 1, fromBeforePass: true }],
        foreignCommits: [],
        summary: 'Lands 1 page on build',
        gate: { where: 'folder', consequence: 'If this gate fails, the pass reopens' },
      },
      changed: ['People is no longer finished'],
    };
    expect(PassCloseAnswerDto.parse(changed)).toEqual(changed);
    expect(PassCloseAnswerDto.safeParse({ outcome: 'closing' }).success).toBe(false);
  });

  it('keeps every shared change a take-out names none of', () => {
    expect(TakeOutRequest.parse({})).toEqual({ shared: [] });
  });
});
