import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import { CHAT_GIT_REFUSAL } from '../src/chat/git-rule';
import {
  addAccount,
  addProject,
  gitIn,
  mcpCalls,
  openChat,
  sendAndWait,
  startLiveDaemon,
  until,
  waitForPinnedCodex,
} from './live-chat-daemon';

/**
 * A chat that writes in Your folder, on the real daemon and the builder's signed-in ChatGPT plan. Manual, never CI:
 *   TENDB_LIVE_CODEX=1 pnpm --filter @10db/daemon exec vitest run test/chat-write-codex.live.test.ts
 * The daemon fetches its pinned Codex into its scratch data dir. Each row's observation is also appended to
 * `TENDB_LIVE_REPORT` when set: vitest hides console output.
 */
const liveEnv = loadEnv(process.env);
const live = liveEnv.TENDB_LIVE_CODEX === '1';

function note(text: string): void {
  console.info(text);
  const file = liveEnv.TENDB_LIVE_REPORT;
  if (file !== undefined) appendFileSync(file, `${text}\n`);
}

describe.skipIf(!live)('a chat that writes in Your folder, live, ChatGPT plan', () => {
  it('patches and commits through its tools, and its shell is refused git', async () => {
    const daemon = await startLiveDaemon('lc3');
    try {
      await waitForPinnedCodex(daemon);
      const account = await addAccount(daemon, {
        kind: 'codex_signin',
        label: 'ChatGPT plan live check',
      });
      // A Codex account keeps its login in a folder of its own, so a scratch daemon's account starts signed out:
      // the builder signs it in once, in the browser, at the address the run prints.
      const connect = await daemon.api(
        z.object({ authUrl: z.string().nullable() }),
        `/accounts/${account.id}/connect`,
        { method: 'POST' },
      );
      note(`LC3 sign in at: ${connect.authUrl ?? '(the browser opened by itself)'}`);
      await until('the ChatGPT sign-in to finish', 600_000, () =>
        account.configDir !== null && existsSync(join(account.configDir, 'auth.json'))
          ? true
          : null,
      );
      const project = await addProject(daemon, account.id);
      const chat = await openChat(daemon, project.id, null);
      const items = await sendAndWait(
        daemon,
        chat.conversationId,
        'Do these in order and report what each answered. 1. Create the file lc3.txt containing the word patched with apply_patch. 2. Commit it with the commit_changes tool, message "lc3". 3. Then run `git commit --allow-empty -m shell` in your shell, as an ordinary command, and report the exact words of any refusal.',
        'wait',
        300_000,
      );
      const calls = mcpCalls(items);
      const commands = items.flatMap((i) =>
        i.kind === 'tool_call' && i.call.kind === 'command'
          ? [
              {
                command: i.call.command,
                status: i.call.status,
                refusal: i.call.refusal,
                tail: i.call.outputTail,
              },
            ]
          : [],
      );
      const edits = items.flatMap((i) =>
        i.kind === 'tool_call' && i.call.kind === 'edit' ? [[i.call.path, i.call.status]] : [],
      );
      note(`LC3 edits: ${JSON.stringify(edits)}`);
      note(`LC3 mcp calls: ${JSON.stringify(calls.map((c) => [c.tool, c.status]))}`);
      note(`LC3 commands: ${JSON.stringify(commands)}`);
      expect(readFileSync(join(daemon.repo, 'lc3.txt'), 'utf8').trim()).toBe('patched');
      expect(gitIn(daemon.repo, 'log', '--format=%s').split('\n')).toContain('lc3');
      expect(calls.some((c) => c.tool === 'commit_changes' && c.status === 'done')).toBe(true);
      // The shell's commit never landed, and the refusal names the tools.
      expect(gitIn(daemon.repo, 'log', '--format=%s').split('\n')).not.toContain('shell');
      const refused = commands.find((c) => c.command.includes('git commit'));
      expect(`${refused?.refusal ?? ''} ${refused?.tail ?? ''}`).toContain('commit_changes');
      expect(CHAT_GIT_REFUSAL).toContain('commit_changes');
    } finally {
      await daemon.stop();
    }
  }, 1_200_000);
});
