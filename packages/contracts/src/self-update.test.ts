import { describe, expect, it } from 'vitest';
import { CommitSha, HealthResponse, SelfUpdateInput, SelfUpdateStatusDto } from './index';

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

describe('SelfUpdateInput', () => {
  it.each([true, false, null])('takes %s', (enabled) => {
    expect(SelfUpdateInput.parse({ enabled })).toEqual({ enabled });
  });

  it('needs the choice', () => {
    expect(SelfUpdateInput.safeParse({}).success).toBe(false);
  });
});

describe('SelfUpdateStatusDto', () => {
  it('describes the switch and the commits', () => {
    const status = {
      enabled: true,
      isDefault: true,
      runningCommit: SHA,
      availableCommit: null,
    };
    expect(SelfUpdateStatusDto.parse(status)).toEqual(status);
  });
});
