import {
  ConversationItemKind,
  ConversationState,
  EventType,
  FolderWhileHeld,
  parseItemBody,
  ChatId,
  PassState,
  WorkstreamState,
  mintId,
  type ChatDto,
} from '@10db/contracts';
import { insertPass, insertTask, insertWorkstream, listItems, schema, setChatWork } from '@10db/db';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from './chat-world';
import { createTempRepo, isolatedGitEnv, waitFor, type TempDir } from './fixtures';

// Sessions spec §7.3: a chat holds Your folder exactly while its turn runs, takes it only when nothing of
// 10db's holds it, and says so in its thread, on a real store, the explore engine and the fake adapter.

let w: ChatWorld;
/** The world a restarted one runs over: it owns the store. */
let previous: ChatWorld | undefined;
afterEach(async () => {
  await w.close();
  await previous?.close();
  previous = undefined;
});

/** A session working in the checkout: only such a session takes the folder for its turn. */
function openHere(tabPosition?: number): ChatDto {
  const chat = w.open(tabPosition);
  w.state.write((ctx) => setChatWork(ctx, ChatId.parse(chat.id), null, { place: 'here' }));
  return chat;
}

const say = (chat: ChatDto, text: string) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });

const sayWith = (chat: ChatDto, text: string, folder: FolderWhileHeld) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] }, folder);

const notices = (chat: ChatDto): string[] =>
  listItems(w.state.db, chat.conversationId, {})
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => parseItemBody(i.kind, i.body))
    .flatMap((b) => ('text' in b && typeof b.text === 'string' ? [b.text] : []));

/** A task of the project running in Your folder, as the scheduler leaves it once it started. */
function runningTask(title: string): void {
  w.state.write((ctx) => {
    const task = insertTask(ctx, w.project.id, {
      title,
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Running, workspaceMode: 'shared' })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
  });
}

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

  it('gives the folder back when the turn ends in error', async () => {
    w = chatWorld();
    const chat = openHere();
    w.adapter.shapeBehaviour = () => Promise.reject(new Error('the agent failed'));
    say(chat, 'fix it');
    await w.engine.settled(chat.conversationId);
    expect(['ended_error', 'idle_cold', 'idle_warm']).toContain(stateOf(chat));
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('gives the folder back when the chat is archived in the middle of its turn', async () => {
    w = chatWorld();
    const chat = openHere();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return { text: 'Done.' };
      };
    });
    say(chat, 'fix it');
    await started;
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    const archived = w.chat.archive(chat.id);
    release();
    await archived;
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });

  it('runs read-only behind a task, with a notice naming it, and still gives nothing back later', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    say(chat, 'look at it');
    await w.engine.settled(chat.conversationId);
    expect(notices(chat)).toEqual([
      'Your checkout is in use by the task ‘Bump vite’, so this turn reads only.',
    ]);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });

  it('shares with another chat, and each knows', async () => {
    w = chatWorld();
    const first = openHere(0);
    const second = openHere(1);
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
    say(first, 'one');
    await started;
    say(second, 'two');
    expect(w.folderHold.holdsTurn(second.id)).toBe(true);
    release();
    await w.engine.settled(first.conversationId);
    await w.engine.settled(second.conversationId);
    expect(notices(second)).toEqual(['Your checkout is also in use by the chat ‘one’.']);
    expect(notices(first)).toEqual(['Your checkout is also in use by the chat ‘two’.']);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });
});

/** The task ends and says so, as the runner's transition does. */
function laneEnds(): void {
  w.state.write((ctx) => {
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Failed })
      .where(eq(schema.workstreams.state, WorkstreamState.Running))
      .run();
    ctx.emit({
      type: EventType.WorkstreamChanged,
      entityType: 'workstream',
      entityId: 'wst_x',
      data: {},
    });
  });
}

const stateOf = (chat: ChatDto) => w.engine.view(chat.conversationId).state;

describe('a message that waits for Your folder', () => {
  it('parks while a task holds, blocks other starts, and runs holding once the task ends', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    expect(listItems(w.state.db, chat.conversationId, {}).length).toBeGreaterThan(1);
  });

  it('keeps a Wait message parked after it stopped a brief turn, until the folder frees', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    let finish: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          finish = r;
        });
        w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
        return { text: 'Brief.' };
      };
    });
    w.chat.askBrief(chat.id);
    await started;

    sayWith(chat, 'edit it', FolderWhileHeld.Wait);

    finish();
    await waitFor(() => w.folderHold.waiting(chat.id) || undefined);
    await w.engine.settled(chat.conversationId);
    // The stop that the send made ended, and the message still waits: it was not released read only.
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    expect(w.engine.parked(chat.conversationId)).toBe(true);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('sends at once when nothing holds the folder', async () => {
    w = chatWorld();
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
  });

  it('lets another message join the queue, and the latest send’s choice applies to all of it', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'one', FolderWhileHeld.Wait);
    sayWith(chat, 'two', FolderWhileHeld.Wait);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    sayWith(chat, 'three', FolderWhileHeld.ReadOnly);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    await w.engine.settled(chat.conversationId);
    expect(notices(chat)).toEqual([
      'Your checkout is in use by the task ‘Bump vite’, so this turn reads only.',
    ]);
  });

  it('runs a message sent reading only without the folder even when it has freed since the choice', async () => {
    w = chatWorld();
    const chat = openHere();
    sayWith(chat, 'look', FolderWhileHeld.ReadOnly);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    await w.engine.settled(chat.conversationId);
    expect(notices(chat)).toEqual([]);
    // The choice was for that message alone: the next one takes the folder as it always does.
    say(chat, 'now edit it');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
  });

  it('does not carry a reading-only choice made during a running turn into a later send', async () => {
    w = chatWorld();
    runningTask('Bump vite');
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
    say(chat, 'look');
    await started;
    // The chained turn inherits the running turn's profile, so the choice is never taken by a turn start.
    sayWith(chat, 'look again', FolderWhileHeld.ReadOnly);
    laneEnds();
    release();
    await w.engine.settled(chat.conversationId);
    say(chat, 'now edit it');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
  });

  it('runs reading only under Send Now', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'look', FolderWhileHeld.Wait);
    w.chat.sendNow(chat.conversationId);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toHaveLength(1);
  });

  it('is dropped by Stop, and nothing starts when the task ends', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.stop(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    // The chat takes the next message as any other.
    say(chat, 'again');
    await w.engine.settled(chat.conversationId);
    expect(stateOf(chat)).toBe(ConversationState.IdleWarm);
  });

  it('is replaced by Redo, which carries its own choice', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.redo(
      chat.conversationId,
      { text: 'look instead', mentions: [], pictures: [] },
      FolderWhileHeld.ReadOnly,
    );
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toHaveLength(1);
  });

  it('keeps waiting through a model change', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.patch(chat.id, { model: 'claude-sonnet-5-5' });
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
  });

  it('is cancelled by archive, with its reservation, so the folder goes to nobody', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.archive(chat.id);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    laneEnds();
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    expect(stateOf(chat)).not.toBe(ConversationState.Running);
  });

  it('is gone after a restart, and the message waits under Send Now', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = openHere();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    previous = w;
    await previous.engine.close();
    w = chatWorld({ over: previous });
    await w.engine.recover();
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.engine.view(chat.conversationId).sendNow).toBe(true);
    laneEnds();
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    w.chat.sendNow(chat.conversationId);
    await w.engine.settled(chat.conversationId);
  });
});

// A chat's edit lands only while its turn holds Your folder. The agent here edits as a real one does: the
// guard's verdict decides whether the file is written, in a real repository, and git says what changed.
describe('what lands in a real repository', () => {
  let repo: TempDir | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  const porcelain = (path: string): string =>
    execFileSync('git', ['-C', path, 'status', '--porcelain'], {
      env: isolatedGitEnv(),
      encoding: 'utf8',
    });

  /** A task that is between its steps: its run isn't going, and its edits are still in the folder. */
  function taskBetweenSteps(): void {
    runningTask('Bump vite');
    w.state.write((ctx) => {
      ctx.tx
        .update(schema.workstreams)
        .set({ state: WorkstreamState.WaitingHuman })
        .where(eq(schema.workstreams.state, WorkstreamState.Running))
        .run();
    });
  }

  function openPass(): void {
    w.state.write((ctx) => {
      const task = insertTask(ctx, w.project.id, {
        title: 'Page',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      insertPass(ctx, {
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
    });
  }

  const rows: {
    readonly name: string;
    readonly holder: (() => void) | null;
    readonly lands: boolean;
  }[] = [
    { name: 'nothing else holds the folder', holder: null, lands: true },
    {
      name: 'a task runs in Your folder',
      holder: () => {
        runningTask('Bump vite');
      },
      lands: false,
    },
    { name: 'a task waits between its steps', holder: taskBetweenSteps, lands: false },
    { name: 'a pass is open', holder: openPass, lands: false },
    {
      name: 'a pass is closed and waits for its pull request',
      holder: () => {
        openPass();
        w.state.write((ctx) => {
          ctx.tx.update(schema.passes).set({ state: PassState.Closed }).run();
        });
      },
      lands: true,
    },
    {
      name: '10db is doing git work in it',
      holder: () => {
        const git = w.folderHold.reserveGit(w.project.id, 'switching Your folder back to `main`');
        if (!git.reserved) throw new Error('git work was refused');
      },
      lands: false,
    },
    {
      name: 'another chat’s turn holds it',
      holder: () => {
        const other = openHere();
        expect(w.folderHold.takeTurn(w.project.id, other.id).taken).toBe(true);
      },
      lands: true,
    },
  ];

  it.each(rows)('edits notes.md only when it can: $name', async ({ holder, lands }) => {
    repo = createTempRepo();
    w = chatWorld({ checkout: repo.path });
    holder?.();
    const chat = openHere();
    const target = join(repo.path, 'notes.md');
    let verdict = '';
    w.adapter.shapeBehaviour = () => {
      const spec = w.adapter.shapeSessions[0]?.spec;
      const decided = spec?.preToolUse({
        toolName: 'Write',
        input: { file_path: target, content: 'edited\n' },
      });
      verdict = decided?.decision ?? 'none';
      // The agent writes only what the guard lets through.
      if (decided?.decision === 'allow') writeFileSync(target, 'edited\n');
      return Promise.resolve({ text: 'Done.' });
    };
    say(chat, 'add notes.md');
    await w.engine.settled(chat.conversationId);
    expect(verdict).toBe(lands ? 'allow' : 'deny');
    expect(existsSync(target)).toBe(lands);
    expect(porcelain(repo.path)).toBe(lands ? '?? notes.md\n' : '');
    if (lands) expect(readFileSync(target, 'utf8')).toBe('edited\n');
  });
});
