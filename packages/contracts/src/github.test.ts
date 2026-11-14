import { describe, expect, it } from 'vitest';
import {
  GITHUB_LOGIN_MESSAGE_MAX,
  GithubLoginEndedData,
  GithubSigninDto,
  GithubState,
  GithubStatusDto,
} from './github';

const CHECKED_AT = '2026-11-12T10:00:00.000Z';

describe('GithubStatusDto', () => {
  it('has no off state, because no switch exists', () => {
    expect(Object.values(GithubState)).toEqual([
      'not_installed',
      'signed_out',
      'signed_in',
      'unreachable',
    ]);
  });
  it('restores a running sign-in from the status', () => {
    const signingIn = {
      code: 'ABCD-1234',
      url: 'https://github.com/login/device',
      startedAt: CHECKED_AT,
    };
    const dto = { state: 'signed_out', login: null, checkedAt: CHECKED_AT, signingIn };
    expect(GithubStatusDto.parse(dto)).toEqual(dto);
    expect(GithubStatusDto.parse({ ...dto, signingIn: null }).signingIn).toBeNull();
  });
  it('refuses a sign-in page that is not the device page', () => {
    const bad = {
      state: 'signed_out',
      login: null,
      checkedAt: CHECKED_AT,
      signingIn: { code: 'ABCD-1234', url: 'https://evil.example/', startedAt: CHECKED_AT },
    };
    expect(GithubStatusDto.safeParse(bad).success).toBe(false);
  });
});

describe('GithubSigninDto', () => {
  it('takes the code and the device page', () => {
    const dto = { code: 'ABCD-1234', url: 'https://github.com/login/device' };
    expect(GithubSigninDto.parse(dto)).toEqual(dto);
    expect(GithubSigninDto.safeParse({ ...dto, url: 'https://github.com/' }).success).toBe(false);
  });
});

describe('GithubLoginEndedData', () => {
  it('bounds the message it carries', () => {
    const ok = {
      ok: false,
      login: null,
      message: 'x'.repeat(GITHUB_LOGIN_MESSAGE_MAX),
      cancelled: false,
    };
    expect(GithubLoginEndedData.parse(ok)).toEqual(ok);
    expect(
      GithubLoginEndedData.safeParse({ ...ok, message: 'x'.repeat(GITHUB_LOGIN_MESSAGE_MAX + 1) })
        .success,
    ).toBe(false);
  });
});
