import { describe, expect, it } from 'vitest';
import { AccountConnectDto, AccountConnectingDto, AccountLoginEndedData } from './accounts';
import { mintId } from './ids';
import { isSignInUrl, SIGN_IN_HOSTS } from './sign-in-url';

const ACCEPTED = [
  'https://auth.openai.com/oauth/authorize?state=abc',
  'https://auth.openai.com/',
  'https://auth.openai.com:443/oauth/authorize',
  'HTTPS://AUTH.OPENAI.COM/x',
];
const REFUSED = [
  { name: 'http', url: 'http://auth.openai.com/oauth/authorize' },
  { name: 'another host', url: 'https://evil.example/oauth/authorize' },
  { name: 'a suffix of the host', url: 'https://auth.openai.com.evil.example/' },
  { name: 'a subdomain', url: 'https://x.auth.openai.com/' },
  { name: 'credentials in front of the host', url: 'https://auth.openai.com@evil.example/' },
  { name: 'a user and password and a port', url: 'https://u:p@auth.openai.com:8443/' },
  { name: 'a user alone', url: 'https://u@auth.openai.com/' },
  { name: 'another port', url: 'https://auth.openai.com:8443/oauth/authorize' },
  { name: 'a javascript address', url: 'javascript:alert(1)' },
  { name: 'text that is no address', url: 'not a url' },
  { name: 'an empty string', url: '' },
];

describe('isSignInUrl', () => {
  it('names one host', () => {
    expect(SIGN_IN_HOSTS).toEqual(['auth.openai.com']);
  });
  it.each(ACCEPTED)('accepts %s', (url) => {
    expect(isSignInUrl(url)).toBe(true);
  });
  it.each(REFUSED)('refuses $name', ({ url }) => {
    expect(isSignInUrl(url)).toBe(false);
  });
});

describe('AccountConnectDto', () => {
  const accountId = mintId('Account');
  it('takes a sign-in page or no page at all', () => {
    expect(
      AccountConnectDto.safeParse({ accountId, authUrl: 'https://auth.openai.com/x' }).success,
    ).toBe(true);
    expect(AccountConnectDto.safeParse({ accountId, authUrl: null }).success).toBe(true);
  });
  it.each(REFUSED)('refuses $name as the page', ({ url }) => {
    expect(AccountConnectDto.safeParse({ accountId, authUrl: url }).success).toBe(false);
  });
});

describe('the sign-in event and slot', () => {
  const accountId = mintId('Account');
  it('an ended sign-in says whether the builder cancelled it', () => {
    const ended = { accountId, ok: false, message: 'The sign-in was cancelled.', cancelled: true };
    expect(AccountLoginEndedData.parse(ended)).toEqual(ended);
    expect(AccountLoginEndedData.safeParse({ accountId, ok: true, message: 'x' }).success).toBe(
      false,
    );
  });
  it('the slot names the account that is connecting', () => {
    expect(AccountConnectingDto.parse({ accountId, label: 'Plan A' })).toEqual({
      accountId,
      label: 'Plan A',
    });
  });
});
