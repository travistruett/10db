import { describe, expect, it } from 'vitest';
import { githubRepoOf } from './repo-name';

describe('githubRepoOf', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    ['https://gitlab.com/acme/widgets.git', null],
    ['git@gitlab.com:acme/widgets.git', null],
    ['https://github.com/acme', null],
    ['https://github.com/acme/widgets/extra', null],
    ['/Users/me/remotes/widgets.git', null],
  ])('%s names %s', (url, repo) => {
    expect(githubRepoOf(url)).toBe(repo);
  });
});
