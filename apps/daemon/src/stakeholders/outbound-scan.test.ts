import { describe, expect, it } from 'vitest';
import { OUTBOUND_PATTERNS, scanOutbound } from './index';

// Made-up values shaped like real credentials, assembled so the secret scanner does not flag this file.
const fake = (...parts: string[]) => parts.join('');

describe('scanOutbound hits', () => {
  it.each([
    ['private_key', fake('-----BEGIN RSA ', 'PRIVATE KEY-----'), 'hold'],
    ['private_key', fake('-----BEGIN ', 'PRIVATE KEY-----'), 'hold'],
    ['aws_access_key', fake('AKIA', 'IOSFODNN7EXAMPLE'), 'hold'],
    ['github_token', fake('gh', 'p_', 'a'.repeat(36)), 'hold'],
    ['github_token', fake('gh', 'o_', 'b'.repeat(36)), 'hold'],
    ['github_token', fake('github', '_pat_', 'c'.repeat(30)), 'hold'],
    ['slack_token', fake('xo', 'xb-1234567890-abcdefghij'), 'hold'],
    ['slack_token', fake('xa', 'pp-1-A0123-4567890123-abcdef'), 'hold'],
    ['openai_key', fake('s', 'k-', 'a'.repeat(32)), 'hold'],
    ['anthropic_key', fake('s', 'k-ant-', 'api03-', 'a'.repeat(30)), 'hold'],
    ['jwt', fake('ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'), 'hold'],
    ['credential_assignment', 'password=hunter22', 'hold'],
    ['credential_assignment', 'API_KEY = abc123', 'hold'],
    ['credential_assignment', 'token=abc', 'hold'],
    ['url', 'see https://example.com/pricing for it', 'hold'],
    ['url', 'http://localhost:3000', 'hold'],
    ['url', 'go to www.example.com now', 'hold'],
    ['code_block', 'run:\n```\nls\n```', 'hold'],
    ['file_path', 'It lives in src/billing/renew.ts today', 'warn'],
    ['file_path', 'edit apps/daemon/src/x', 'warn'],
    ['file_path', 'the page /pricing/annual should say', 'warn'],
    ['file_path', 'open ./lib/thing.js', 'warn'],
  ])('%s hits in %j as %s', (name, text, severity) => {
    const hits = scanOutbound(text);
    expect(hits).toContainEqual(expect.objectContaining({ pattern: name, severity }));
  });

  it('a path warns and does not hold', () => {
    const hits = scanOutbound('/pricing/annual');
    expect(hits.map((h) => [h.pattern, h.severity])).toEqual([['file_path', 'warn']]);
  });

  it('reports the line, 1-based, and never the matched text', () => {
    const hits = scanOutbound(`fine\nstill fine\n${fake('password', '=hunter22')}`);
    expect(hits).toEqual([{ pattern: 'credential_assignment', line: 3, severity: 'hold' }]);
  });

  it('reports one hit per pattern per line', () => {
    const hits = scanOutbound('https://a.test and https://b.test');
    expect(hits).toEqual([{ pattern: 'url', line: 1, severity: 'hold' }]);
  });

  it('lists hits in line order', () => {
    const hits = scanOutbound('https://a.test\nsrc/a/b.ts');
    expect(hits.map((h) => [h.line, h.pattern])).toEqual([
      [1, 'url'],
      [2, 'file_path'],
    ]);
  });
});

describe('scanOutbound near misses', () => {
  it.each([
    ['sk- inside a word', 'the risk-assessment-and-mitigation-plan-for-everything is done'],
    ['ghp with no suffix', 'ghp is short for something'],
    ['gh token prefix too short', fake('gh', 'p_', 'abc')],
    ['and/or', 'Keep access and/or notify'],
    ['24/7', 'support is 24/7'],
    ['a date', 'due 11/12/2026'],
    ['a fraction', 'about 3/4 of customers'],
    ['a colon sentence about tokens', 'the token: valid for 24 hours'],
    ['plain prose', 'Keep access for 7 days, then downgrade.'],
    ['AKIA inside a word', 'MAKIAVELLI-ISH'],
    ['two backticks only', 'use ``x`` inline'],
  ])('%s does not hit', (_name, text) => {
    expect(scanOutbound(text)).toEqual([]);
  });
});

describe('OUTBOUND_PATTERNS', () => {
  it('names each pattern once', () => {
    const names = OUTBOUND_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds on anything that could be a secret, a link or code, and only warns on a path', () => {
    const warns = OUTBOUND_PATTERNS.filter((p) => p.severity === 'warn').map((p) => p.name);
    expect(warns).toEqual(['file_path']);
  });
});
