import { describe, expect, it } from 'vitest';
import {
  CommitSha,
  HealthResponse,
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
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
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
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    blocker: null,
  };

  it('describes the switch, the commits and the wait', () => {
    expect(SelfUpdateStatusDto.parse(status)).toEqual(status);
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
