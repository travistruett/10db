import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { worktreePathFor } from './worktree-path';

describe('worktreePathFor', () => {
  it("names the project slug, the id's last 6 hex and the branch leaf", () => {
    const id = mintId('Project');
    expect(
      worktreePathFor('/root/ab12cd34', { id, name: 'Acme Widgets!' }, '10db/alpha-0a1b2c3d'),
    ).toBe(`/root/ab12cd34/acme-widgets-${id.slice(-6)}/alpha-0a1b2c3d`);
  });

  it('an empty slug falls back to project', () => {
    const id = mintId('Project');
    expect(worktreePathFor('/root', { id, name: '***' }, '10db/batch-0a1b2c3d')).toBe(
      `/root/project-${id.slice(-6)}/batch-0a1b2c3d`,
    );
  });
});
