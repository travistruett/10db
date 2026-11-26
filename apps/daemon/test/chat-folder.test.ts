import {
  ConversationItemKind,
  parseItemBody,
  ChatId,
  mintId,
  PassState,
  PermissionChoice,
  type ChatDto,
  type InboxItemDto,
} from '@10db/contracts';
import { insertPass, insertTask, listInbox, listItems, schema, setChatWork } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createPermissionBroker } from '../src/inbox';
import { silentLogger } from '../src/log';
import { EMPTY_SETUP, type FileAccessContext } from '../src/sandbox';
import type { ToolDecision } from '../src/sessions';
import type { ShapePrepareInput, ShapePrepared } from '../src/shape';
import { chatWorld, type ChatWorld } from './chat-world';
import { waitFor } from './fixtures';

// Sessions spec §7.3: a chat holds Your folder exactly while its turn runs, takes it only when nothing of
// 10db's holds it, and says so in its thread, on a real store, the explore engine and the fake adapter.

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

/** A session working in the checkout: only such a session takes the folder for its turn. */
function openHere(tabPosition?: number): ChatDto {
  const chat = w.open(tabPosition);
  w.state.write((ctx) => setChatWork(ctx, ChatId.parse(chat.id), null, { place: 'here' }));
  return chat;
}

const say = (chat: ChatDto, text: string) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });

const notices = (chat: ChatDto): string[] =>
  listItems(w.state.db, chat.conversationId, {})
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => parseItemBody(i.kind, i.body))
    .flatMap((b) => ('text' in b && typeof b.text === 'string' ? [b.text] : []));

describe('a chat’s turn and Your folder', () => {
  it('holds the folder while the turn runs and gives it back when it ends', async () => {
    w = chatWorld();
    const chat = openHere();
    say(chat, 'fix it');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('keeps the hold through a chained turn and takes it once', async () => {
    w = chatWorld();
    const chat = openHere();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
        return { text: 'Understood.' };
      };
    });
    say(chat, 'one');
    await started;
    say(chat, 'two');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    release();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });
});

/** The NO_GIT and file access a broker that reads no package files and no real checkout needs. */
const NO_GIT = {
  commitAt: () => Promise.reject(new Error('no repository')),
  folderAt: () => Promise.reject(new Error('no repository')),
  fileAt: () => Promise.resolve({ kind: 'missing' as const }),
};
const FILE_ACCESS: FileAccessContext = {
  checkout: '/repo',
  home: '/home',
  protectedReads: [],
  readList: [],
  systemDocRoots: [],
  configDir: '/home/.claude',
  providerSessionId: null,
  sandboxTemp: { roots: ['/tmp/10db'], own: '/tmp/10db/own' },
};

/** A session with the real permission broker and no sandbox, so a command outside it reaches the builder. */
function brokerPrepare(input: ShapePrepareInput): Promise<ShapePrepared> {
  const broker = createPermissionBroker(
    { state: w.state, inbox: w.inbox, git: NO_GIT, logger: silentLogger },
    {
      projectId: input.projectId,
      workstreamId: null,
      conversationId: input.conversationId,
      chat: true,
      sessionId: input.sessionId,
      observer: input.observer,
      signal: input.signal,
      sandbox: {
        fileAccess: FILE_ACCESS,
        hazards: [],
        commandsAsk: true,
        ...(input.unsandboxedAsk === undefined
          ? {}
          : { unsandboxed: { agent: input.harness, ...input.unsandboxedAsk } }),
      },
    },
  );
  return Promise.resolve({
    sandbox: null,
    projectMcpServers: {},
    yourMcpServers: {},
    note: null,
    credentialsExpireAt: null,
    instructions: null,
    setup: EMPTY_SETUP,
    canUseTool: broker,
    trackProcesses: () => undefined,
    markOwn: () => undefined,
    endJobs: () => Promise.resolve(),
    release: () => Promise.resolve(),
  });
}

const outsideTest = () => ({
  toolName: 'Bash',
  input: { command: 'pnpm test', dangerouslyDisableSandbox: true },
  toolUseId: 't1',
  escalated: false,
  signal: new AbortController().signal,
});
const openCards = (): InboxItemDto[] => listInbox(w.state.db, { states: ['OPEN'] });

describe('a chat’s remembered command outside the sandbox', () => {
  it('forgets it when the turn ends and when another chat joins the checkout', async () => {
    w = chatWorld({ prepare: brokerPrepare });
    // A closed pass waiting for its merge shares the folder with a turn and writes nothing: it stops no remembering.
    w.state.write((ctx) => {
      const task = insertTask(ctx, w.project.id, {
        title: 'Page',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      const opened = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: w.project.id,
        name: 'Settings pass',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/pass-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [task.id],
        dirt: [],
      });
      ctx.tx
        .update(schema.passes)
        .set({ state: PassState.Closed })
        .where(eq(schema.passes.id, opened.pass.id))
        .run();
    });
    const chat = openHere();
    const other = openHere(1);
    const seen: {
      readonly what: string;
      readonly decision: ToolDecision;
      readonly asked: boolean;
    }[] = [];
    // Runs the command once, answering its card with `answer` if one opens.
    const run = async (
      ask: (req: ReturnType<typeof outsideTest>) => Promise<ToolDecision>,
      what: string,
      answer: PermissionChoice,
    ): Promise<void> => {
      const pending = ask(outsideTest());
      let decided = false;
      void pending.then(() => {
        decided = true;
      });
      // A card, or null once the call was decided with none.
      const card = await waitFor(() => openCards()[0] ?? (decided ? null : undefined));
      if (card !== null) w.inbox.answer(card.id, { choice: answer });
      seen.push({ what, decision: await pending, asked: card !== null });
    };
    w.adapter.shapeBehaviour = async (turn) => {
      if (turn.message.includes('join')) return { text: 'Joined.' };
      const ask = (req: ReturnType<typeof outsideTest>) => turn.spec.canUseTool(req);
      if (turn.message.includes('two')) {
        await run(ask, 'next turn', PermissionChoice.Deny);
        return { text: 'Done.' };
      }
      await run(ask, 'first', PermissionChoice.AllowChat);
      await run(ask, 'again', PermissionChoice.Deny);
      // Another chat's turn shares the checkout and ends; what it may have changed is unseen by this session.
      say(other, 'join');
      await w.engine.settled(other.conversationId);
      await waitFor(() => !w.folderHold.holdsTurn(other.id));
      await run(ask, 'after a join', PermissionChoice.AllowChat);
      await run(ask, 'again after the join', PermissionChoice.Deny);
      return { text: 'Done.' };
    };
    say(chat, 'one');
    await w.engine.settled(chat.conversationId);
    say(chat, 'two');
    await w.engine.settled(chat.conversationId);
    expect(seen.map((s) => [s.what, s.asked, s.decision.behavior])).toEqual([
      ['first', true, 'allow'],
      ['again', false, 'allow'],
      ['after a join', true, 'allow'],
      ['again after the join', false, 'allow'],
      ['next turn', true, 'deny'],
    ]);
  });
});
