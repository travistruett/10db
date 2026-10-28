import { describe, expect, it } from 'vitest';
import { McpHost, SystemCheckDto } from './index';

describe('SystemCheckDto', () => {
  it('accepts a report with a missing optional tool', () => {
    const report = {
      loginEnv: { source: 'login_shell', warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        {
          name: 'claude',
          path: '/h/b/.local/bin/claude',
          version: '2.1.299 (Claude Code)',
          required: true,
        },
        { name: 'docker', path: null, version: null, required: false },
      ],
    };
    expect(SystemCheckDto.parse(report)).toEqual({ ...report, benchmarkSync: null });
  });

  it('reads a failed Artificial Analysis sync, and refuses an outcome that is not a failure', () => {
    const warning = {
      outcome: 'rate_limited',
      message: 'The daily Artificial Analysis limit is used up',
    };
    const report = {
      loginEnv: { source: 'login_shell', warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [],
      benchmarkSync: warning,
    };
    expect(SystemCheckDto.parse(report)).toEqual(report);
    expect(
      SystemCheckDto.safeParse({ ...report, benchmarkSync: { outcome: 'ok', message: '8 models' } })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown tool name', () => {
    expect(
      SystemCheckDto.safeParse({
        loginEnv: { source: 'inherited', warning: 'x' },
        claudeCode: { verifiedOn: '2.1.302', warning: null },
        tools: [{ name: 'node', path: null, version: null, required: true }],
      }).success,
    ).toBe(false);
  });
});

describe('McpHost', () => {
  it.each([
    ['an exact name', 'registry.npmjs.org'],
    ['a wildcard over a domain', '*.example.org'],
    ['hyphens and a country domain', 'a-b.example.co.uk'],
    ['a digit-led label', '1password.com'],
  ])('accepts %s', (_name, host) => {
    expect(McpHost.parse(host)).toBe(host);
  });

  it.each([
    ['upper case', 'Example.com'],
    ['localhost', 'localhost'],
    ['a name under localhost', 'foo.localhost'],
    ['a wildcard over localhost', '*.localhost'],
    ['a wildcard over a top-level domain', '*.com'],
    ['a single label', 'com'],
    ['an IPv4 address', '127.0.0.1'],
    ['an IPv4-looking last label', 'example.123'],
    ['an IPv6 address', '[::1]'],
    ['a bare wildcard', '*'],
    ['two wildcards', '*.*.example.org'],
    ['a wildcard inside a name', 'api.*.example.org'],
    ['a trailing dot', 'example.org.'],
    ['a label starting with a hyphen', '-a.example.org'],
    ['a label ending with a hyphen', 'a-.example.org'],
    ['an empty label', 'a..example.org'],
    ['a port', 'example.org:443'],
    ['a URL', 'https://example.org'],
    ['a label over 63 characters', `${'a'.repeat(64)}.example.org`],
    ['a name over 253 characters', `${'a.'.repeat(126)}org`],
  ])('refuses %s', (_name, host) => {
    expect(McpHost.safeParse(host).success).toBe(false);
  });
});
