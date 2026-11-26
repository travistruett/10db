import {
  LinearEventKind,
  LinearStatusType,
  type LinearTeamStatus as TeamStatus,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { pickStatusMove } from './reporter-status';

const status = (name: string, type: LinearStatusType, position: number): TeamStatus => ({
  name,
  type,
  position,
});

const TEAM: readonly TeamStatus[] = [
  status('Triage', LinearStatusType.Triage, 0),
  status('Backlog', LinearStatusType.Backlog, 1),
  status('Todo', LinearStatusType.Unstarted, 2),
  status('In Progress', LinearStatusType.Started, 3),
  status('In Review', LinearStatusType.Started, 4),
  status('Ready for Release', LinearStatusType.Started, 5),
  status('Done', LinearStatusType.Completed, 6),
  status('Canceled', LinearStatusType.Canceled, 7),
];

const at = (name: string): TeamStatus => {
  const found = TEAM.find((s) => s.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

const move = (event: LinearEventKind, current: string, lastSet: string | null = null) =>
  pickStatusMove({ event, current: at(current), statuses: TEAM, lastSet })?.name ?? null;

describe('pickStatusMove', () => {
  it('moves an issue not yet started to the first started status when the run starts', () => {
    expect(move(LinearEventKind.RunStarted, 'Triage')).toBe('In Progress');
    expect(move(LinearEventKind.RunStarted, 'Backlog')).toBe('In Progress');
    expect(move(LinearEventKind.RunStarted, 'Todo')).toBe('In Progress');
    // Linear's MCP server lists no positions, in no fixed order: the names place the two started statuses.
    const unordered: TeamStatus[] = [
      { name: 'In Review', type: LinearStatusType.Started },
      { name: 'In Progress', type: LinearStatusType.Started },
      { name: 'Backlog', type: LinearStatusType.Backlog },
      { name: 'Duplicate', type: 'duplicate' },
    ];
    const pick = (event: LinearEventKind, name: string) => {
      const current = unordered.find((s) => s.name === name);
      if (current === undefined) throw new Error(name);
      return pickStatusMove({ event, current, statuses: unordered, lastSet: null })?.name ?? null;
    };
    expect(pick(LinearEventKind.RunStarted, 'Backlog')).toBe('In Progress');
    expect(pick(LinearEventKind.Landed, 'Backlog')).toBe('In Review');
    expect(pick(LinearEventKind.Landed, 'In Progress')).toBe('In Review');
    expect(pick(LinearEventKind.Landed, 'In Review')).toBeNull();
    expect(pick(LinearEventKind.Landed, 'Duplicate')).toBeNull();
  });

  it('leaves a started, completed or canceled issue alone when the run starts', () => {
    for (const name of ['In Progress', 'In Review', 'Done', 'Canceled'])
      expect(move(LinearEventKind.RunStarted, name)).toBeNull();
  });

  it('moves to the review-like started status when work lands, never backwards or to completed', () => {
    for (const event of [LinearEventKind.PrOpened, LinearEventKind.Landed]) {
      expect(move(event, 'Backlog')).toBe('In Review');
      expect(move(event, 'In Progress')).toBe('In Review');
      expect(move(event, 'In Review')).toBeNull();
      expect(move(event, 'Ready for Release')).toBeNull();
      expect(move(event, 'Done')).toBeNull();
    }
  });

  it('picks by type and position when the names say nothing', () => {
    const team = [
      status('Next', LinearStatusType.Unstarted, 10),
      status('Doing', LinearStatusType.Started, 20),
      status('Checking', LinearStatusType.Started, 30),
      status('Shipped', LinearStatusType.Completed, 40),
    ];
    const current = team[1];
    if (current === undefined) throw new Error('team');
    expect(
      pickStatusMove({ event: LinearEventKind.PrOpened, current, statuses: team, lastSet: null })
        ?.name,
    ).toBe('Checking');
  });

  it('finds no review-like status in a team with one started status', () => {
    const team = [
      status('Todo', LinearStatusType.Unstarted, 1),
      status('Doing', LinearStatusType.Started, 2),
      status('Done', LinearStatusType.Completed, 3),
    ];
    const current = team[1];
    if (current === undefined) throw new Error('team');
    expect(
      pickStatusMove({ event: LinearEventKind.Landed, current, statuses: team, lastSet: null }),
    ).toBeNull();
  });

  it('uses the name only to break a tie between started statuses after the current one', () => {
    const team = [
      status('Todo', LinearStatusType.Unstarted, 1),
      status('In Progress', LinearStatusType.Started, 2),
      status('QA Hold', LinearStatusType.Started, 3),
      status('Code Review', LinearStatusType.Started, 4),
    ];
    const current = team[1];
    if (current === undefined) throw new Error('team');
    expect(
      pickStatusMove({ event: LinearEventKind.PrOpened, current, statuses: team, lastSet: null })
        ?.name,
    ).toBe('Code Review');
  });

  it('leaves a status the builder set since 10db last set one', () => {
    expect(move(LinearEventKind.PrOpened, 'In Progress', 'In Progress')).toBe('In Review');
    expect(move(LinearEventKind.PrOpened, 'Backlog', 'In Progress')).toBeNull();
    expect(move(LinearEventKind.RunStarted, 'Todo', 'In Review')).toBeNull();
  });

  it('moves nothing for events that report no progress to the status', () => {
    for (const event of [
      LinearEventKind.Waiting,
      LinearEventKind.Verdict,
      LinearEventKind.Ended,
      LinearEventKind.PrMerged,
    ])
      expect(move(event, 'Backlog')).toBeNull();
  });
});
