import { WHOLE_REPOSITORY_GLOBS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { scopeAreas } from './knowledge-areas';

describe('scopeAreas', () => {
  it.each([
    { name: 'no areas', areas: [], offered: [] },
    {
      name: 'the default area over the whole repository',
      areas: [{ name: 'repo', globs: [...WHOLE_REPOSITORY_GLOBS] }],
      offered: [],
    },
    {
      name: 'a real area beside the catch-all',
      areas: [
        { name: 'api', globs: ['apps/daemon/**'] },
        { name: 'rest', globs: [...WHOLE_REPOSITORY_GLOBS], catchAll: true },
      ],
      offered: ['api'],
    },
    {
      name: 'an area of dotfiles only, which is not the whole repository',
      areas: [{ name: 'dotfiles', globs: ['**/.*'] }],
      offered: ['dotfiles'],
    },
  ])('$name', ({ areas, offered }) => {
    expect(scopeAreas(areas)).toEqual(offered);
  });
});
