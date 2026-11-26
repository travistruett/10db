import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationDto, ConversationState, PermissionChoice } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import { CHAT_GIT_REFUSAL } from '../src/chat/git-rule';
import {
  addAccount,
  addProject,
  gitIn,
  itemsOf,
  mcpCalls,
  openCards,
  openChat,
  sendAndWait,
  startLiveDaemon,
  until,
  waitForPinnedCodex,
  type LiveDaemon,
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

/** A ChatGPT plan account on the scratch daemon, signed in by the builder at the address the run prints. */
async function signedInAccount(daemon: LiveDaemon, tag: string) {
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
  note(`${tag} sign in at: ${connect.authUrl ?? '(the browser opened by itself)'}`);
  await until('the ChatGPT sign-in to finish', 600_000, () =>
    account.configDir !== null && existsSync(join(account.configDir, 'auth.json')) ? true : null,
  );
  return account;
}

/** Answers a card as the builder does on the Inbox. */
async function answer(daemon: LiveDaemon, id: string, choice: string, said?: string) {
  await daemon.api(z.looseObject({}), `/inbox/${id}/answer`, {
    method: 'POST',
    body: { choice, ...(said === undefined ? {} : { note: said }) },
  });
}

describe.skipIf(!live)('a chat that writes in Your folder, live, ChatGPT plan', () => {
  it('patches and commits through its tools, and its shell is refused git', async () => {
    const daemon = await startLiveDaemon('lc3');
    try {
      const account = await signedInAccount(daemon, 'LC3');
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

  it('asks before a command its sandbox blocked runs outside it, and a No carries the note', async () => {
    const daemon = await startLiveDaemon('lc5');
    try {
      const account = await signedInAccount(daemon, 'LC5');
      const project = await addProject(daemon, account.id);
      const chat = await openChat(daemon, project.id, null);
      // Outside the checkout and every temp root, so only a command outside the sandbox can write here.
      const outside = join(daemon.work.path, 'outside');
      mkdirSync(outside);
      const allowedFile = join(outside, 'lc5.txt');
      const deniedFile = join(outside, 'lc5-denied.txt');
      const ask = (file: string): string =>
        `Run exactly \`touch ${file}\` in your shell and report what happened. If the sandbox blocks it, ask to run it outside the sandbox.`;
      /** Sends one message; each card to run a command outside the sandbox is answered by `onCard`. */
      const turn = async (
        text: string,
        onCard: (card: { id: string; body: string }) => { choice: string; note?: string },
      ): Promise<{ cards: string[]; said: string[] }> => {
        const before = (await itemsOf(daemon, chat.conversationId)).length;
        await daemon.api(z.looseObject({}), `/conversations/${chat.conversationId}/messages`, {
          method: 'POST',
          body: { text, folder: 'wait' },
        });
        const cards: string[] = [];
        await until('the turn to end', 300_000, async () => {
          const card = (await openCards(daemon)).find(
            (c) => c.title === 'Run this outside the sandbox?',
          );
          if (card !== undefined) {
            cards.push(card.body);
            const reply = onCard(card);
            await answer(daemon, card.id, reply.choice, reply.note);
            return null;
          }
          const state = (await daemon.api(ConversationDto, `/conversations/${chat.conversationId}`))
            .state;
          const items = (await itemsOf(daemon, chat.conversationId)).slice(before);
          const settled =
            state === ConversationState.IdleWarm || state === ConversationState.IdleCold;
          return settled && items.some((i) => i.kind === 'agent_message') ? true : null;
        });
        const said = (await itemsOf(daemon, chat.conversationId))
          .slice(before)
          .flatMap((i) => (i.kind === 'agent_message' ? [i.text.slice(0, 400)] : []));
        return { cards, said };
      };

      // The sandbox blocks the write, Codex escalates it, and the builder allows it for this chat.
      const first = await turn(ask(allowedFile), () => ({ choice: PermissionChoice.AllowChat }));
      note(`LC5 first cards: ${JSON.stringify(first.cards)}`);
      note(`LC5 first said: ${JSON.stringify(first.said)}`);
      expect(first.cards.length).toBe(1);
      expect(first.cards[0]).toContain(allowedFile);
      expect(existsSync(allowedFile)).toBe(true);

      // The same command again: remembered for this chat when Codex's hook counts the sandboxed attempt
      // before the escalation, asked again when it does not. Either is safe; the run says which.
      const again = await turn(ask(allowedFile), () => ({ choice: PermissionChoice.AllowOnce }));
      note(`LC5 repeat asked again: ${String(again.cards.length > 0)}`);
      note(`LC5 repeat said: ${JSON.stringify(again.said)}`);

      // A No with a note: the command never runs, and the chat is told the builder's note.
      const reason = 'No: write it inside the checkout instead.';
      const denied = await turn(ask(deniedFile), () => ({
        choice: PermissionChoice.Deny,
        note: reason,
      }));
      note(`LC5 denied cards: ${JSON.stringify(denied.cards)}`);
      note(`LC5 denied said: ${JSON.stringify(denied.said)}`);
      expect(denied.cards.length).toBe(1);
      expect(existsSync(deniedFile)).toBe(false);
    } finally {
      await daemon.stop();
    }
  }, 1_800_000);
});
