import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePrScopes, scopeOf, type PrScopes } from './pr-scopes';

const SCOPES: PrScopes = {
  daemon: ['apps/daemon'],
  desktop: ['apps/desktop'],
  docs: ['docs', 'README.md'],
  repo: ['scripts', 'package.json'],
  ci: ['.github'],
  nested: ['docs/nested'],
};

describe('scopeOf', () => {
  it.each<{ name: string; paths: string[]; scopes: PrScopes | null; expected: string | null }>([
    {
      name: 'every path under one scope',
      paths: ['apps/daemon/src/a.ts', 'apps/daemon/AGENTS.md'],
      scopes: SCOPES,
      expected: 'daemon',
    },
    {
      name: 'a file the scope names exactly',
      paths: ['README.md', 'docs/x.md'],
      scopes: SCOPES,
      expected: 'docs',
    },
    {
      name: 'paths under two scopes',
      paths: ['apps/daemon/src/a.ts', 'apps/desktop/src/b.tsx'],
      scopes: SCOPES,
      expected: null,
    },
    {
      name: 'a path under no scope',
      paths: ['apps/daemon/src/a.ts', 'pnpm-lock.yaml'],
      scopes: SCOPES,
      expected: null,
    },
    {
      name: 'a sibling that only shares the prefix',
      paths: ['apps/daemonic/x.ts'],
      scopes: SCOPES,
      expected: null,
    },
    {
      name: 'a file that only shares the prefix',
      paths: ['package.json5'],
      scopes: SCOPES,
      expected: null,
    },
    {
      name: 'the longest entry wins',
      paths: ['docs/nested/x.md'],
      scopes: SCOPES,
      expected: 'nested',
    },
    {
      name: 'the longest entry wins beside its parent',
      paths: ['docs/nested/x.md', 'docs/y.md'],
      scopes: SCOPES,
      expected: null,
    },
    { name: 'no paths', paths: [], scopes: SCOPES, expected: null },
    { name: 'no scope list', paths: ['apps/daemon/src/a.ts'], scopes: null, expected: null },
  ])('$name', ({ paths, scopes, expected }) => {
    expect(scopeOf(paths, scopes)).toBe(expected);
  });
});

describe('parsePrScopes', () => {
  it("reads this repository's own scope list", () => {
    const text = readFileSync(new URL('../../../../.10db/pr-scopes.json', import.meta.url), 'utf8');
    expect(parsePrScopes(text)).toMatchObject({ daemon: ['apps/daemon'] });
  });

  it('reads a scope list', () => {
    expect(parsePrScopes('{"scopes":{"daemon":["apps/daemon"],"ci":[".github"]}}')).toEqual({
      daemon: ['apps/daemon'],
      ci: ['.github'],
    });
  });

  it.each([
    { name: 'not JSON', text: '{scopes' },
    { name: 'no scopes field', text: '{}' },
    { name: 'an unknown field', text: '{"scopes":{},"extra":1}' },
    { name: 'an uppercase scope', text: '{"scopes":{"Daemon":["apps/daemon"]}}' },
    { name: 'a scope with a space', text: '{"scopes":{"a b":["x"]}}' },
    { name: 'a scope with a parenthesis', text: '{"scopes":{"a)":["x"]}}' },
    { name: 'a scope with no paths', text: '{"scopes":{"daemon":[]}}' },
    { name: 'an absolute path', text: '{"scopes":{"daemon":["/apps/daemon"]}}' },
    { name: 'a trailing slash', text: '{"scopes":{"daemon":["apps/daemon/"]}}' },
    { name: 'a parent step', text: '{"scopes":{"daemon":["apps/../x"]}}' },
    { name: 'a current-directory step', text: '{"scopes":{"daemon":["./apps"]}}' },
    { name: 'an empty step', text: '{"scopes":{"daemon":["apps//daemon"]}}' },
  ])('refuses $name', ({ text }) => {
    expect(parsePrScopes(text)).toBeNull();
  });
});
