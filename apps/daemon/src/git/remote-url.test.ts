import { describe, expect, it } from 'vitest';
import { parseRemoteUrl, redactUrls } from './remote-url';

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['HTTPS://GitHub.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['ssh://github.com/acme/widgets.git', 'ssh://github.com/acme/widgets.git'],
    ['git@github.com:acme/widgets.git', 'git@github.com:acme/widgets.git'],
    ['ssh://git@github.com/acme/widgets.git', 'ssh://git@github.com/acme/widgets.git'],
    ['ssh://git@host.example:2222/x.git', 'ssh://git@host.example:2222/x.git'],
    ['/Users/me/remotes/widgets.git', '/Users/me/remotes/widgets.git'],
    ['file:///Users/me/remotes/widgets.git', 'file:///Users/me/remotes/widgets.git'],
  ])('accepts %s as %s', (raw, url) => {
    expect(parseRemoteUrl(raw)).toEqual({ ok: true, url });
  });

  it.each([
    ['a token', 'https://x-access-token:tok-s3cret@github.com/acme/widgets.git'],
    ['a user and password', 'https://user:pass@github.com/acme/widgets.git'],
    ['a user in an https URL', 'https://git@github.com/acme/widgets.git'],
    ['an ssh password', 'ssh://git:pw@github.com/acme/widgets.git'],
    ['a second @ after an ssh user', 'ssh://git@evil.invalid@github.com/acme/widgets.git'],
    ['a ? after an ssh user', 'ssh://git@github.com/acme/widgets?x'],
    ['an scp user that reads as an ssh option', '-oProxyCommand=touch.x@host:acme/widgets'],
    ['an scp host that reads as an ssh option', '-oProxyCommand=x:acme/widgets'],
    ['several @', 'https://user:p@ss@github.com/acme/widgets.git'],
    ['a ? before an @', 'https://a?@evil.invalid/x@github.com/acme/widgets'],
    ['a # before an @', 'https://a#@evil.invalid/x@github.com/acme/widgets'],
    ['a backslash', 'https://github.com\\@evil.invalid/acme/widgets'],
    ['whitespace', 'https://github.com/acme/wid gets'],
    ['a newline', 'https://github.com/acme\n/widgets'],
    ['a control character', 'https://github.com/acme\u0001/widgets'],
    ['a transport helper', 'ext::sh -c touch% /tmp/x'],
    ['an unknown scheme', 'ftp://github.com/acme/widgets'],
    ['a relative path', 'remotes/widgets.git'],
    ['nothing', ''],
  ])('refuses a URL with %s', (_name, raw) => {
    expect(parseRemoteUrl(raw).ok).toBe(false);
  });
});

describe('redactUrls', () => {
  it.each([
    ['https://user:tok@host/x', 'https://***@host/x'],
    ['https://user:p@ss@word@host/x', 'https://***@host/x'],
    ['To https://a@b@c@host/x and https://t@h/y', 'To https://***@host/x and https://***@h/y'],
  ])('masks every userinfo in %s', (text, masked) => {
    expect(redactUrls(text)).toBe(masked);
  });
});
