import { execFileSync } from 'node:child_process';
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
  addAccount,
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
// Needs `AWS_PROFILE` (a signed-in profile) and, when it is not us-east-1, `AWS_REGION`.
const bedrockLive = live && liveEnv.TENDB_LIVE_BEDROCK === '1';

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

  it('reopens a warm session on the read-only profile and resumes the conversation', async () => {
    const daemon = await startLiveDaemon('lc4', { claudePath: localClaude() });
    try {
      const project = await addProject(daemon, null);
      const chat = await openChat(daemon, project.id, null);
      const word = 'quokka-lc4';
      const first = await sendAndWait(
        daemon,
        chat.conversationId,
        `Remember this word: ${word}. Create the file lc4.txt containing ok with your edit tool, then reply done.`,
        'wait',
      );
      expect(existsSync(join(daemon.repo, 'lc4.txt'))).toBe(true);
      note(`LC4 turn 1 items: ${String(first.length)}`);
      // A task that waits on the builder keeps the folder, so the next turn cannot write.
      const task = await daemon.api(
        z.looseObject({ id: z.string() }),
        `/projects/${project.id}/tasks`,
        {
          method: 'POST',
          body: {
            title: 'Wait for an answer',
            description:
              'Ask the builder with your question tool which colour to use, and do nothing until it is answered.',
            acceptanceCriteria: ['the builder answered'],
            areas: ['repo'],
            workspaceMode: 'shared',
          },
        },
      );
      await daemon.api(z.looseObject({}), `/tasks/${task.id}/start`, { method: 'POST', body: {} });
      const folder = await until('the task to hold the folder', 120_000, async () => {
        const view = await daemon.api(
          z.looseObject({ holders: z.array(z.looseObject({ kind: z.string() })) }),
          `/projects/${project.id}/folder`,
        );
        return view.holders.some((h) => h.kind === 'lane') ? view : null;
      });
      note(`LC4 holders: ${JSON.stringify(folder.holders.map((h) => h.kind))}`);
      const second = await sendAndWait(
        daemon,
        chat.conversationId,
        'What was the word I asked you to remember? Reply with the word only.',
        'read_only',
      );
      const reply = second.flatMap((i) => (i.kind === 'agent_message' ? [i.text] : [])).join(' ');
      note(`LC4 turn 2 reply: ${reply}`);
      note(
        `LC4 notices: ${JSON.stringify(second.flatMap((i) => (i.kind === 'notice' ? [i.text] : [])))}`,
      );
      // The conversation's sessions as the daemon's own scratch database keeps them: one agent session id on both.
      const sessions = execFileSync(
        'sqlite3',
        [
          '-readonly',
          '-separator',
          ' ',
          join(daemon.work.path, 'data', '10db.sqlite'),
          `select provider_session_id, exit_reason from sessions where conversation_id = '${chat.conversationId}' order by sequence`,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n');
      note(`LC4 sessions: ${JSON.stringify(sessions)}`);
      // The first session ended because the folder changed hands; the second runs the same agent session.
      expect(sessions).toHaveLength(2);
      const [firstId, secondId] = sessions.map((row) => row.split(' ')[0]);
      expect(firstId).toBe(secondId);
      expect(sessions[0]).toContain('the folder changed hands');
      expect(reply).toContain(word);
    } finally {
      await daemon.stop();
    }
  }, 600_000);
});

describe.skipIf(!bedrockLive)('a chat that writes in Your folder, live, Bedrock', () => {
  it('edits a file in one turn', async () => {
    const profile = process.env['AWS_PROFILE'];
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    if (profile === undefined) throw new Error('LC5 needs AWS_PROFILE set to a signed-in profile');
    const daemon = await startLiveDaemon('lc5', { claudePath: localClaude() });
    try {
      const account = await addAccount(daemon, {
        kind: 'bedrock',
        label: 'Bedrock live check',
        settings: { region, awsProfile: profile },
      });
      const project = await addProject(daemon, account.id);
      const chat = await openChat(daemon, project.id, null);
      const items = await sendAndWait(
        daemon,
        chat.conversationId,
        'Create the file lc5.txt containing exactly the word bedrock, with your edit tool, then reply done.',
        'wait',
      );
      expect(readFileSync(join(daemon.repo, 'lc5.txt'), 'utf8').trim()).toBe('bedrock');
      // The turn ran on the Bedrock account, as the scratch database records it.
      const kinds = execFileSync(
        'sqlite3',
        [
          '-readonly',
          join(daemon.work.path, 'data', '10db.sqlite'),
          `select distinct a.kind from sessions s join accounts a on a.id = s.account_id where s.conversation_id = '${chat.conversationId}'`,
        ],
        { encoding: 'utf8' },
      ).trim();
      note(`LC5 account kind of the session: ${kinds}`);
      expect(kinds).toBe('bedrock');
      note(
        `LC5 edit calls: ${JSON.stringify(items.flatMap((i) => (i.kind === 'tool_call' ? [[i.call.kind, i.call.status]] : [])))}`,
      );
    } finally {
      await daemon.stop();
    }
  }, 420_000);
});
