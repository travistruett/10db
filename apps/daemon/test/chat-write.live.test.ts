import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import {
  addProject,
  builderIdentity,
  gitIn,
  localClaude,
  mcpCalls,
  openChat,
  sendAndWait,
  startLiveDaemon,
} from './live-chat-daemon';

/**
 * A chat that writes in Your folder, on the real daemon and the builder's signed-in Claude plan. Manual,
 * never CI:
 *   TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/chat-write.live.test.ts
 * Each row's observation is also appended to `TENDB_LIVE_REPORT` when set: vitest hides console output.
 */
const liveEnv = loadEnv(process.env);
const live = liveEnv.TENDB_LIVE_CLAUDE === '1';

function note(text: string): void {
  console.info(text);
  const file = liveEnv.TENDB_LIVE_REPORT;
  if (file !== undefined) appendFileSync(file, `${text}\n`);
}

describe.skipIf(!live)('a chat that writes in Your folder, live, Claude plan', () => {
  it('edits a file and commits it as the builder, and runs no hook of the repository', async () => {
    const daemon = await startLiveDaemon('lc1', {
      claudePath: localClaude(),
      prepareRepo: (repo) => {
        // A hook that would leave a marker, and a hooks path that would redirect git to one.
        const hook = join(repo, '.git/hooks/pre-commit');
        writeFileSync(hook, `#!/bin/sh\necho ran > "${join(repo, '.git/hook-marker')}"\n`);
        chmodSync(hook, 0o755);
      },
    });
    try {
      const project = await addProject(daemon, null);
      const chat = await openChat(daemon, project.id, null);
      const items = await sendAndWait(
        daemon,
        chat.conversationId,
        'Create the file notes.txt containing exactly the word marker, with your edit tool. Then commit it with the commit_changes tool, message "add notes". Reply done when it has landed.',
        'wait',
      );
      const calls = mcpCalls(items);
      note(`LC1 mcp calls: ${JSON.stringify(calls.map((c) => [c.tool, c.status]))}`);
      expect(readFileSync(join(daemon.repo, 'notes.txt'), 'utf8').trim()).toBe('marker');
      expect(gitIn(daemon.repo, 'log', '-1', '--format=%s').trim()).toBe('add notes');
      const author = gitIn(daemon.repo, 'log', '-1', '--format=%an%n%ae').trim().split('\n');
      const builder = builderIdentity();
      note(
        `LC1 author is the builder: ${String(author[0] === builder.name && author[1] === builder.email)}`,
      );
      expect(author).toEqual([builder.name, builder.email]);
      expect(existsSync(join(daemon.repo, '.git/hook-marker'))).toBe(false);
      note('LC1 pre-commit marker present: false');
    } finally {
      await daemon.stop();
    }
  }, 420_000);
});
