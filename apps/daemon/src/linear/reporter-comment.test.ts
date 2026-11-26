import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { commentText, footerOf } from './reporter-comment';

const post = { id: mintId('LinearPost'), event: 'ended', attempt: 2 };

describe('commentText', () => {
  it('strips internal ids, step indexes and home-folder paths from what the agent wrote', () => {
    const ws = mintId('Workstream');
    const task = mintId('Task');
    const body = [
      `Verdict (attempt 2, review step, step index 2, workstream ${ws.slice(0, 11)}…): rejected.`,
      `Task ${task} touched /Users/someone/.10db/worktrees/ab/cd/apps/daemon/src/linear/reporter.ts and ~/Projects/x/notes.md.`,
      `Post ${post.id} is recorded.`,
    ].join('\n');
    const text = commentText(body, post);
    expect(text).not.toMatch(/\b(?:ws|tsk|lnp)_[0-9a-f]/);
    expect(text).not.toMatch(/step index/i);
    expect(text).not.toMatch(/\/Users\/|~\//);
    expect(text).toContain('reporter.ts');
    expect(text).toContain('rejected.');
  });

  it('ends with a short footer that holds no id', () => {
    expect(footerOf(post)).toBe('10db · ended · attempt 2');
    expect(commentText('The run finished and its work landed.', post)).toBe(
      'The run finished and its work landed.\n\n10db · ended · attempt 2',
    );
  });
});
