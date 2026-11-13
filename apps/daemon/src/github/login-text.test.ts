import { describe, expect, it } from 'vitest';
import { GITHUB_LOGIN_MESSAGE_MAX } from '@10db/contracts';
import { loginFailureMessage, parseDeviceLogin, stripAnsi } from './login-text';

const CODE_LINE = '! First copy your one-time code: ABCD-1234';
const URL_LINE = 'Open this URL to continue in your web browser: https://github.com/login/device';
const FOUND = { code: 'ABCD-1234', url: 'https://github.com/login/device' };

describe('parseDeviceLogin', () => {
  it.each([
    { name: "gh 2.83.2's text", lines: ['', CODE_LINE, URL_LINE], expected: FOUND },
    { name: 'the url line first', lines: [URL_LINE, CODE_LINE], expected: FOUND },
    {
      name: 'carriage returns',
      lines: [`${CODE_LINE}\r`, `${URL_LINE}\r`],
      expected: FOUND,
    },
    {
      name: 'ANSI colour codes',
      lines: [
        '\u001b[33m!\u001b[0m First copy your one-time code: \u001b[1mABCD-1234\u001b[0m',
        `Open this URL to continue in your web browser: \u001b[36mhttps://github.com/login/device\u001b[0m`,
      ],
      expected: FOUND,
    },
    {
      name: 'noise around the two lines',
      lines: ['- Waiting', CODE_LINE, 'x', URL_LINE, 'y'],
      expected: FOUND,
    },
    { name: 'only the code', lines: [CODE_LINE], expected: null },
    { name: 'only the url', lines: [URL_LINE], expected: null },
    { name: 'nothing', lines: [], expected: null },
    {
      name: 'a url that is not the device page',
      lines: [CODE_LINE, 'Open this URL: https://evil.example/login/device'],
      expected: null,
    },
    {
      name: 'a code that is not 4-4',
      lines: ['First copy your one-time code: ABC-12', URL_LINE],
      expected: null,
    },
  ])('reads $name', ({ lines, expected }) => {
    expect(parseDeviceLogin(lines)).toEqual(expected);
  });
});

describe('stripAnsi', () => {
  it('removes colour and cursor codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[2K\u001b[1Gdone')).toBe('red done');
  });
});

describe('loginFailureMessage', () => {
  it.each([
    {
      name: 'an expired code',
      lines: ['! First copy your one-time code', 'X Authentication failed: expired_token'],
      expected: 'The code expired. Press Sign In to get a new one.',
    },
    {
      name: 'a refusal at GitHub',
      lines: ['access_denied'],
      expected: 'GitHub refused the sign-in.',
    },
    {
      name: 'no network',
      lines: ['error connecting to github.com'],
      expected: "10db couldn't reach GitHub.",
    },
    {
      name: 'an unknown message: the last line, without colour codes',
      lines: ['first', '\u001b[31mgh: something odd\u001b[0m', ''],
      expected: 'gh: something odd',
    },
    { name: 'no output at all', lines: [], expected: 'gh stopped before the sign-in finished.' },
  ])('maps $name', ({ lines, expected }) => {
    expect(loginFailureMessage(lines)).toBe(expected);
  });
  it('cuts a long line to the bound', () => {
    const message = loginFailureMessage(['y'.repeat(500)]);
    expect(message).toHaveLength(GITHUB_LOGIN_MESSAGE_MAX);
  });
});
