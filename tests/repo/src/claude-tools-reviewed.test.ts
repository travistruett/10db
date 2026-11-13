import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

describe('the reviewed Claude Code tools', () => {
  it('were reviewed for the Claude Code release 10db pins', () => {
    const pinned = /CLAUDE_CODE_VERIFIED_ON\s*=\s*['"]([^'"]+)['"]/.exec(
      readRepoFile('apps/daemon/src/environment/agent-pins.ts'),
    )?.[1];
    const reviewed = /version:\s*['"]([^'"]+)['"]/.exec(
      readRepoFile('apps/daemon/src/guard/reviewed-tools.ts'),
    )?.[1];
    expect(pinned).toBeDefined();
    // A Claude Code bump lists tools this review has not seen; review them, then move `version`.
    expect(reviewed).toBe(pinned);
  });
});
