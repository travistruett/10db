import { describe, expect, it } from 'vitest';
import { cannotUpdate } from './blocker';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const build = { commit: SHA, repository: 'o/10db', releaseDir: '/r', updatable: true };

describe('cannotUpdate', () => {
  it('is null for an app in Applications that knows its repository, with gh installed', () => {
    expect(cannotUpdate(build, true)).toBeNull();
  });

  it('says a run from source never updates itself', () => {
    expect(cannotUpdate(null, true)).toMatchObject({ kind: 'source' });
  });

  it('says a build with no repository in build-info.json cannot know where to update from', () => {
    const found = cannotUpdate({ ...build, repository: null, updatable: false }, true);
    expect(found?.kind).toBe('no-repository');
    expect(found?.message).toContain('build-info.json');
  });

  it('says a copy outside Applications is left as it is', () => {
    const found = cannotUpdate({ ...build, updatable: false }, true);
    expect(found?.kind).toBe('not-in-applications');
    expect(found?.message).toContain('/Applications');
  });

  it('says gh is not installed', () => {
    const found = cannotUpdate(build, false);
    expect(found?.kind).toBe('gh-missing');
    expect(found?.message).toContain('gh');
  });
});
