import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { JudgeKind, mintId, type SessionId } from '@10db/contracts';
import { getChat } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import {
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
} from '../../test/fixtures';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { chatGitTools } from './git-tools';
import { createChatLiveSessions } from './live-sessions';

// Push, open pull request and merge work before any edit: a session that only reads becomes a Here session when
// the call is let through, takes the checkout, and a refused call changes nothing (rows 5 and 6).

let w: ChatWorld;
let pair: ReturnType<typeof createTempRepoWithOrigin>;
let network: ReturnType<typeof githubOrigin>;
let scratch: ReturnType<typeof tempDir>;
afterEach(async () => {
  await w.close();
  network.cleanup();
  scratch.cleanup();
  pair.cleanup();
});

const rg = (...args: string[]) =>
  execFileSync('git', ['-C', pair.repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function world() {
  pair = createTempRepoWithOrigin();
  network = githubOrigin(pair.repo.path, pair.origin.path);
  scratch = tempDir('reading-git');
  w = chatWorld({
    checkout: pair.repo.path,
    project: { repoPath: pair.repo.path },
    judge: JudgeKind.Native,
  });
  rg('switch', '-q', '-c', 'topic');
  const chat = w.open();
  const live = createChatLiveSessions();
  const sessionId: SessionId = mintId('Session');
  live.open(chat.conversationId, {
    sessionId,
    observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
    signal: new AbortController().signal,
  });
  const tools = chatGitTools(
    {
      git: createGit(),
      folderHold: w.folderHold,
      live,
      gh: new FakeGh(),
      filesDir: () => join(scratch.path, 'files'),
      repoOf: () => pair.repo.path,
      secretFilesOf: secretFilesIn,
      net: () => ({
        env: { ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global },
        timeoutMs: 20_000,
      }),
      takeHere: (chatId) => {
        w.work.takeHereForGitTool(chatId);
      },
    },
    { sessionId, conversationId: chat.conversationId, chatId: chat.id, projectId: w.project.id },
  );
  return { chat, tools };
}

const originHas = (branch: string) =>
  execFileSync(
    'git',
    ['--git-dir', pair.origin.path, 'rev-parse', '--verify', `refs/heads/${branch}`],
    {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    },
  )
    .toString()
    .trim();

describe("a reading session's git tools", () => {
  it('runs a push that was let through: the session goes Here and holds the checkout (row 5)', async () => {
    const { chat, tools } = world();
    expect(getChat(w.state.db, chat.id).workPlace).toBeNull();
    await tools.push_branch({});
    expect(originHas('topic')).toBe(rg('rev-parse', 'HEAD'));
    expect(getChat(w.state.db, chat.id).workPlace).toBe('here');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
  });

  it("is refused under a Board task's hold, naming it, and stays Here (row 5)", async () => {
    const { chat, tools } = world();
    const lane = w.folderHold.reserveGit(w.project.id, 'a lane is changing main');
    if (!lane.reserved) throw new Error('the checkout was not free');
    await expect(tools.push_branch({})).rejects.toThrow(/a lane is changing main/);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('here');
    expect(() => originHas('topic')).toThrow();
  });

  it('records nothing when the judge refuses the call (row 6)', () => {
    const { chat } = world();
    w.chat.send(chat.conversationId, { text: 'ship it', mentions: [], pictures: [] });
    return w.engine.settled(chat.conversationId).then(() => {
      const spec = w.adapter.shapeSessions[0]?.spec;
      // The judged tool is asked about before it runs, so a refused call never reaches the tool's code.
      expect(spec?.preToolUse({ toolName: 'mcp__10db__push_branch', input: {} }).decision).not.toBe(
        'allow',
      );
      expect(getChat(w.state.db, chat.id).workPlace).toBeNull();
    });
  });
});
