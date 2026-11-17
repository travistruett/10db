import { describe, expect, it } from 'vitest';
import { chatProfile } from './hooks';
import { chatSystemPrompt } from './prompt';

// Sessions spec §7.1, §7.2: the chat is told it can write while its turn holds the folder, and how git works here.

describe("a chat's prompt", () => {
  it.each([true, false])(
    'says it edits while its turn holds the folder, and not that it changes nothing (web %s)',
    (web) => {
      const text = chatSystemPrompt(web);
      expect(text).toContain('only while your turn holds the folder');
      expect(text).not.toMatch(/changes nothing in it|don't edit files yet/);
    },
  );

  it('sends git through the tools, commits only when asked, and says hooks do not run', () => {
    const text = chatSystemPrompt(true);
    for (const tool of [
      'make_branch',
      'switch_branch',
      'pull',
      'commit_changes',
      'push_branch',
      'open_pull_request',
      'merge_pull_request',
    ])
      expect(text).toContain(tool);
    expect(text).toContain('only when the builder asks');
    expect(text).toContain("Git hooks don't run");
    expect(text).toContain('10db/');
  });

  it('tells the session to make its first change with an edit, not a shell write', () => {
    expect(chatSystemPrompt(true)).toContain(
      'make your first change with an edit tool, not a shell write',
    );
  });

  it('turns file checkpointing on for a chat that can edit, and off for one with no sandbox', () => {
    expect(chatProfile(true).fileCheckpointing).toBe(true);
    expect(chatProfile(false).fileCheckpointing).toBe(false);
  });
});
