import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DoItBriefDto,
  DoItPreviewDto,
  DoItResult,
  PassSignOff,
  PassViewDto,
  TaskSessionDto,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import {
  addAccount,
  addProject,
  gitIn,
  itemsOf,
  localClaude,
  mcpCalls,
  openChat,
  sendAndWait,
  startLiveDaemon,
  until,
  waitForPinnedCodex,
  type LiveDaemon,
} from './live-chat-daemon';

/**
 * Do It, on the real daemon and the builder's signed-in accounts. Manual, never CI:
 *   TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/do-it.live.test.ts
 *   (LC8 also needs TENDB_LIVE_BEDROCK=1 and a signed-in AWS_PROFILE; LC7 needs TENDB_LIVE_CODEX=1)
 * Each row's observation is also appended to `TENDB_LIVE_REPORT` when set: vitest hides console output.
 */
const liveEnv = loadEnv(process.env);
const claudeLive = liveEnv.TENDB_LIVE_CLAUDE === '1';
const bedrockLive = claudeLive && liveEnv.TENDB_LIVE_BEDROCK === '1';
const codexLive = liveEnv.TENDB_LIVE_CODEX === '1';

function note(text: string): void {
  console.info(text);
  const file = liveEnv.TENDB_LIVE_REPORT;
  if (file !== undefined) appendFileSync(file, `${text}\n`);
}

const BRIEF_DEADLINE_MS = 60_000;

/** Asks the chat's agent for a brief and waits for the preview to hold the agent's own. */
async function briefFromAgent(
  daemon: LiveDaemon,
  chatId: string,
  draft: string,
): Promise<{ brief: DoItBriefDto; ms: number }> {
  const started = Date.now();
  await daemon.api(DoItBriefDto, `/chats/${chatId}/brief`, { method: 'POST', body: { draft } });
  const brief = await until('the agent to write the brief', BRIEF_DEADLINE_MS, async () => {
    const preview = await daemon.api(DoItPreviewDto, `/chats/${chatId}/do-it`);
    return preview.brief.source === 'agent' && !preview.brief.writing ? preview.brief : null;
  });
  return { brief, ms: Date.now() - started };
}

/** Starts a daemon whose chat has talked once, reading only, so that its brief has something to say. */
async function chatWithHistory(daemon: LiveDaemon, accountId: string | null, text: string) {
  const project = await addProject(daemon, accountId);
  const chat = await openChat(daemon, project.id, null);
  await sendAndWait(daemon, chat.conversationId, text, 'read_only');
  return { project, chat };
}

describe.skipIf(!claudeLive)('Do It, live, Claude plan', () => {
  it('LC6: an idle brief turn calls write_brief, reading only, within 60 s', async () => {
    const daemon = await startLiveDaemon('lc6', { claudePath: localClaude() });
    try {
      const { chat } = await chatWithHistory(
        daemon,
        null,
        'Read README.md. We will want a file notes.txt that holds the word marker. Do not change anything yet; reply with one sentence.',
      );
      const headBefore = gitIn(daemon.repo, 'rev-parse', 'HEAD').trim();
      const { brief, ms } = await briefFromAgent(
        daemon,
        chat.id,
        'Make the task: create notes.txt containing marker.',
      );
      const calls = mcpCalls(await itemsOf(daemon, chat.conversationId));
      note(`LC6 brief after ${String(ms)} ms, source ${String(brief.source)}`);
      note(`LC6 title: ${brief.title}; areas ${JSON.stringify(brief.areas)}`);
      note(`LC6 mcp calls: ${JSON.stringify(calls.map((c) => [c.tool, c.status]))}`);
      expect(calls.some((c) => c.tool.includes('write_brief'))).toBe(true);
      expect(brief.text.length).toBeGreaterThan(0);
      // Reading only: no file, no commit, no dirt.
      expect(existsSync(join(daemon.repo, 'notes.txt'))).toBe(false);
      expect(gitIn(daemon.repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
      expect(gitIn(daemon.repo, 'status', '--porcelain').trim()).toBe('');
      note('LC6 repository untouched: true');
    } finally {
      await daemon.stop();
    }
  }, 420_000);
});

describe.skipIf(!bedrockLive)('Do It, live, Bedrock', () => {
  it('LC8: Do It Here, the page edits in its first turn, and Sign Off lands it', async () => {
    const profile = process.env['AWS_PROFILE'];
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    if (profile === undefined) throw new Error('LC8 needs AWS_PROFILE set to a signed-in profile');
    const daemon = await startLiveDaemon('lc8', { claudePath: localClaude() });
    try {
      const account = await addAccount(daemon, {
        kind: 'bedrock',
        label: 'Bedrock live check',
        settings: { region, awsProfile: profile },
      });
      const { chat } = await chatWithHistory(
        daemon,
        account.id,
        'Read README.md. We will add a file lc8.txt that holds the word dope. Reply with one sentence.',
      );
      const result = await daemon.api(DoItResult, `/chats/${chat.id}/do-it`, {
        method: 'POST',
        body: {
          place: 'here',
          title: 'Add lc8.txt',
          brief: 'Create the file lc8.txt containing exactly the word dope, then say it is ready.',
          acceptanceCriteria: ['lc8.txt exists and holds the word dope'],
        },
      });
      if (!('taskId' in result)) throw new Error('Do It Here answered pending, not a task');
      const session = await daemon.api(TaskSessionDto, `/tasks/${result.taskId}/session`);
      note(`LC8 task place ${session.place}, branch ${String(session.branch)}`);
      const passId = session.passId;
      if (passId === null) throw new Error('the task is in no pass');
      const ready = await until("the page's first turn to be ready", 420_000, async () => {
        const view = await daemon.api(PassViewDto, `/passes/${passId}`);
        const page = view.pages[0];
        return page?.turn?.readyAt != null ? view : null;
      });
      note(`LC8 whole-project page: ${String(ready.wholeProject)}`);
      expect(ready.wholeProject).toBe(true);
      expect(readFileSync(join(daemon.repo, 'lc8.txt'), 'utf8').trim()).toBe('dope');
      note('LC8 the first turn edited lc8.txt: true');
      await daemon.api(z.looseObject({}), `/passes/${passId}/tasks/${result.taskId}/sign-off`, {
        method: 'POST',
      });
      const landed = await until('the sign-off to land', 300_000, async () => {
        const view = await daemon.api(PassViewDto, `/passes/${passId}`);
        return view.pages[0]?.signOff === PassSignOff.Done ? view : null;
      });
      note(`LC8 signed off; pass state ${landed.pass.state}`);
      const log = gitIn(daemon.repo, 'log', '--all', '--format=%h %s', '-5').trim();
      note(`LC8 git log: ${log.replaceAll('\n', ' | ')}`);
      expect(gitIn(daemon.repo, 'log', '--all', '--format=%s', '--', 'lc8.txt').trim()).not.toBe(
        '',
      );
      expect(gitIn(daemon.repo, 'status', '--porcelain').trim()).toBe('');
    } finally {
      await daemon.stop();
    }
  }, 900_000);
});

describe.skipIf(!codexLive)('Do It, live, ChatGPT plan', () => {
  it("LC7: an idle brief turn calls write_brief through 10db's /mcp, reading only", async () => {
    const daemon = await startLiveDaemon('lc7');
    try {
      await waitForPinnedCodex(daemon);
      const account = await addAccount(daemon, {
        kind: 'codex_signin',
        label: 'ChatGPT plan live check',
      });
      // A scratch daemon's Codex account starts signed out: the builder signs in once, at the address the run prints.
      const connect = await daemon.api(
        z.object({ authUrl: z.string().nullable() }),
        `/accounts/${account.id}/connect`,
        { method: 'POST' },
      );
      note(`LC7 sign in at: ${connect.authUrl ?? '(the browser opened by itself)'}`);
      await until('the ChatGPT sign-in to finish', 600_000, () =>
        account.configDir !== null && existsSync(join(account.configDir, 'auth.json'))
          ? true
          : null,
      );
      const { chat } = await chatWithHistory(
        daemon,
        account.id,
        'Read README.md. We will want a file notes.txt that holds the word marker. Do not change anything yet; reply with one sentence.',
      );
      const headBefore = gitIn(daemon.repo, 'rev-parse', 'HEAD').trim();
      const { brief, ms } = await briefFromAgent(
        daemon,
        chat.id,
        'Make the task: create notes.txt containing marker.',
      );
      const calls = mcpCalls(await itemsOf(daemon, chat.conversationId));
      note(`LC7 brief after ${String(ms)} ms, source ${String(brief.source)}`);
      note(`LC7 mcp calls: ${JSON.stringify(calls.map((c) => [c.tool, c.status]))}`);
      expect(calls.some((c) => c.tool.includes('write_brief'))).toBe(true);
      expect(existsSync(join(daemon.repo, 'notes.txt'))).toBe(false);
      expect(gitIn(daemon.repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
      expect(gitIn(daemon.repo, 'status', '--porcelain').trim()).toBe('');
    } finally {
      await daemon.stop();
    }
  }, 900_000);
});
