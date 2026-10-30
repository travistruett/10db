import { matchesGlob } from 'node:path';
import { PathPattern } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { literalGlob } from './literal-glob';

describe('literalGlob', () => {
  it.each([
    { path: 'apps/daemon', glob: 'apps/daemon', other: 'apps/desktop' },
    { path: 'app/(product)/app', glob: 'app/(product)/app', other: 'app/product/app' },
    { path: 'app/[orgId]', glob: 'app/[[]orgId]', other: 'app/o' },
    { path: 'app/[...slug]', glob: 'app/[[]...slug]', other: 'app/s' },
    { path: 'app/[[...slug]]', glob: 'app/[[][[]...slug]]', other: 'app/[s]' },
    { path: 'x*y', glob: 'x[*]y', other: 'xzy' },
    { path: 'x?y', glob: 'x[?]y', other: 'xzy' },
    { path: '@(x)', glob: '@[(]x)', other: 'x' },
    { path: '!(x)', glob: '![(]x)', other: 'y' },
    { path: '{{cookiecutter.slug}}', glob: '{{cookiecutter.slug}}', other: 'cookiecutter.slug' },
    { path: '{a,b}', glob: '?a,b?', other: 'a' },
    { path: '{1..3}', glob: '?1..3?', other: '2' },
    { path: '{a,b}(x)', glob: '?a,b?[(]x)', other: '{a,bx' },
    { path: 'back\\slash', glob: 'back?slash', other: 'back/slash' },
    { path: 'a[b', glob: 'a?b', other: 'ab' },
    { path: 'c]d', glob: 'c?d', other: 'cd' },
    { path: 'c:drive', glob: 'c?drive', other: 'cdrive' },
  ])('$path becomes $glob', ({ path, glob, other }) => {
    expect(literalGlob(path)).toBe(glob);
    expect(PathPattern.safeParse(glob).success).toBe(true);
    expect(matchesGlob(`${path}/f.ts`, `${glob}/**`)).toBe(true);
    expect(matchesGlob(`${other}/f.ts`, `${glob}/**`)).toBe(false);
  });
});
