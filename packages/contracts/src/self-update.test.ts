import { describe, expect, it } from 'vitest';
import {
  CommitSha,
  HealthResponse,
  mintId,
  SelfUpdateInput,
  SelfUpdateStatusDto,
  SelfUpdateWaitInput,
} from './index';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('CommitSha', () => {
  it('takes a full lower-case commit SHA', () => {
    expect(CommitSha.parse(SHA)).toBe(SHA);
  });

  it.each(['', 'main', SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}0`])('refuses %j', (value) => {
    expect(CommitSha.safeParse(value).success).toBe(false);
  });
});

describe('HealthResponse commit', () => {
  const base = {
    status: 'ok',
    protocolVersion: 1,
    startedAt: '2026-10-13T12:00:00.000Z',
  };

  it('carries the running commit', () => {
    expect(HealthResponse.parse({ ...base, commit: SHA }).commit).toBe(SHA);
  });

  it('reads as no commit for a source run and for an older daemon', () => {
    expect(HealthResponse.parse({ ...base, commit: null }).commit).toBeNull();
    expect(HealthResponse.parse(base).commit).toBeNull();
  });

  it('refuses a commit that is no SHA', () => {
    expect(HealthResponse.safeParse({ ...base, commit: 'main' }).success).toBe(false);
  });
});

describe('SelfUpdateStatusDto blocker', () => {
  const status = {
    enabled: true,
    isDefault: true,
    runningCommit: SHA,
    availableCommit: null,
    notInstalling: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    midSession: { working: 0, waitingOnCard: 0, batches: 0, jobs: 0, shapes: [] },
  };

  it('is null or a kind with a message', () => {
    expect(SelfUpdateStatusDto.parse({ ...status, blocker: null }).blocker).toBeNull();
    const blocker = { kind: 'gh-missing', message: 'gh is not installed.' };
    expect(SelfUpdateStatusDto.parse({ ...status, blocker }).blocker).toEqual(blocker);
  });

  it('refuses a kind it does not know, and an answer with no blocker field', () => {
    const unknown = { ...status, blocker: { kind: 'sad', message: 'x' } };
    expect(SelfUpdateStatusDto.safeParse(unknown).success).toBe(false);
    expect(SelfUpdateStatusDto.safeParse(status).success).toBe(false);
  });
});

describe('SelfUpdateInput', () => {
  it.each([true, false, null])('takes %s', (enabled) => {
    expect(SelfUpdateInput.parse({ enabled })).toEqual({ enabled });
  });

  it('needs the choice', () => {
    expect(SelfUpdateInput.safeParse({}).success).toBe(false);
  });
});

describe('SelfUpdateWaitInput', () => {
  it.each([0, 15, 1440, null])('takes %s minutes', (minutes) => {
    expect(SelfUpdateWaitInput.parse({ minutes })).toEqual({ minutes });
  });

  it.each([-1, 1.5, 1441, '15'])('refuses %j', (minutes) => {
    expect(SelfUpdateWaitInput.safeParse({ minutes }).success).toBe(false);
  });
});

describe('SelfUpdateStatusDto', () => {
  const status = {
    enabled: true,
    isDefault: true,
    runningCommit: SHA,
    availableCommit: null,
    notInstalling: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    midSession: { working: 0, waitingOnCard: 0, batches: 0, jobs: 0, shapes: [] },
    blocker: null,
  };

  it('describes the switch, the commits and the wait', () => {
    expect(SelfUpdateStatusDto.parse(status)).toEqual(status);
  });

  it.each(['failed', 'rolled-back', 'unbuilt', 'fetching', 'unreachable'])(
    'says an update is not installing: %s',
    (why) => {
      const held = { ...status, availableCommit: SHA, notInstalling: why };
      expect(SelfUpdateStatusDto.parse(held)).toEqual(held);
    },
  );

  it('refuses a reason it does not know', () => {
    expect(SelfUpdateStatusDto.safeParse({ ...status, notInstalling: 'sad' }).success).toBe(false);
  });

  it('says what the update waits for: running work, and lanes waiting on a card', () => {
    const busy = {
      ...status,
      midSession: { working: 2, waitingOnCard: 1, batches: 0, jobs: 0, shapes: [] },
    };
    expect(SelfUpdateStatusDto.parse(busy).midSession).toEqual(busy.midSession);
    expect(
      SelfUpdateStatusDto.safeParse({
        ...status,
        midSession: { ...status.midSession, working: -1 },
      }).success,
    ).toBe(false);
  });

  it('names the shaping conversations whose turn the update waits for', () => {
    const shape = { id: mintId('Shape'), title: 'Denser board' };
    const holding = {
      ...status,
      midSession: { ...status.midSession, working: 1, shapes: [shape] },
    };
    expect(SelfUpdateStatusDto.parse(holding).midSession.shapes).toEqual([shape]);
    expect(
      SelfUpdateStatusDto.safeParse({
        ...status,
        midSession: { ...status.midSession, working: 1, shapes: [{ id: 'nope', title: 'x' }] },
      }).success,
    ).toBe(false);
  });

  it('counts the batches and delivery jobs among the work, apart from the running steps', () => {
    const holding = {
      ...status,
      midSession: { ...status.midSession, working: 3, batches: 1, jobs: 2 },
    };
    expect(SelfUpdateStatusDto.parse(holding).midSession).toMatchObject({ batches: 1, jobs: 2 });
    for (const bad of [{ batches: -1 }, { jobs: 1.5 }]) {
      expect(
        SelfUpdateStatusDto.safeParse({ ...status, midSession: { ...status.midSession, ...bad } })
          .success,
      ).toBe(false);
    }
    const noBatches = { working: 0, waitingOnCard: 0, jobs: 0, shapes: [] };
    expect(SelfUpdateStatusDto.safeParse({ ...status, midSession: noBatches }).success).toBe(false);
  });

  it('says since when an update waits and drains', () => {
    const draining = {
      ...status,
      availableCommit: SHA,
      waitingSince: '2026-11-03T12:00:00.000Z',
      draining: true,
      drainingSince: '2026-11-03T12:15:00.000Z',
    };
    expect(SelfUpdateStatusDto.parse(draining)).toEqual(draining);
  });
});
