import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

describe('scripts/dev.sh', () => {
  const script = readRepoFile('scripts/dev.sh');

  it('shares one dev token between the daemon and the Vite UI', () => {
    expect(script).toContain('TENDB_DEV_UI_TOKEN=');
    expect(script).toContain('VITE_DAEMON_TOKEN=');
  });

  it('generates the token instead of hard-coding one', () => {
    expect(script).toContain('randomBytes(32)');
  });

  it('keeps dev state out of git', () => {
    expect(readRepoFile('.gitignore')).toMatch(/^\/\.dev\/$/m);
  });
});
