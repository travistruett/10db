import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import {
  addProject,
  builderIdentity,
  gitIn,
  localClaude,
  mcpCalls,
  itemsOf,
  openCards,
  openChat,
  sendAndWait,
  startLiveDaemon,
  until,
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

/** The data dir's log lines that match, whatever the log files are called. */
function logLines(root: string, pattern: RegExp): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.log'))
        for (const line of readFileSync(path, 'utf8').split('\n'))
          if (pattern.test(line)) found.push(line.slice(0, 900));
    }
  };
  walk(join(root, 'data'));
  return found.join('\n');
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

  it('asks the builder before a push, with auto mode as the judge', async () => {
    const daemon = await startLiveDaemon('lc2', {
      claudePath: localClaude(),
      prepareRepo: (repo) => {
        // A GitHub address no one owns: a push that got past every check would still reach nothing.
        gitIn(
          repo,
          'remote',
          'add',
          'origin',
          'https://github.com/tendb-live-check/does-not-exist.git',
        );
      },
    });
    try {
      const project = await addProject(daemon, null);
      const chat = await openChat(daemon, project.id, null);
      await daemon.api(z.looseObject({}), `/conversations/${chat.conversationId}/messages`, {
        method: 'POST',
        body: {
          text: 'Do these in order with your own tools, one call each: make_branch named lc2-work; create the file lc2.txt containing ok; commit_changes with message "lc2"; push_branch.',
          folder: 'wait',
        },
      });
      const card = await until(
        'a card for the push',
        240_000,
        async () => (await openCards(daemon)).find((c) => c.kind === 'permission') ?? null,
      );
      note(`LC2 card: ${JSON.stringify([card.kind, card.title, card.body.slice(0, 300)])}`);
      const items = await itemsOf(daemon, chat.conversationId);
      const calls = mcpCalls(items);
      note(`LC2 calls so far: ${JSON.stringify(calls.map((c) => [c.tool, c.status]))}`);
      expect(`${card.title} ${card.body}`).toContain('push_branch');
      // The push waits on the builder: git has not been asked to push yet.
      expect(logLines(daemon.work.path, /GitNetworkError/)).toBe('');
      note('LC2 pushes attempted before the answer: none');
      await daemon.api(z.looseObject({}), `/conversations/${chat.conversationId}/stop`, {
        method: 'POST',
      });
    } finally {
      await daemon.stop();
    }
  }, 420_000);
});
