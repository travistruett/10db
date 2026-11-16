import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, ConversationItemKind, UpstreamError, type ChatDto } from '@10db/contracts';
import { getConversation, listItems } from '@10db/db';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { gate } from '../../test/explore-world';
import { waitFor } from '../../test/fixtures';
import { takeoverFolderOf } from './files';
import { liveTakeoverTempDirs } from './live-temp-dirs';

const McpFile = z.object({ mcpServers: z.record(z.string(), z.unknown()) });
const serversIn = (path: string): string[] =>
  Object.keys(McpFile.parse(JSON.parse(readFileSync(path, 'utf8'))).mcpServers);

// Sessions spec §7.5 on a real store, the real engine, hold and files, and the fake adapter: Open in Terminal,
// Copy the Command, Again and Hand Back, and the races of the opening phase.

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

const say = { mentions: [], pictures: [] };
const stateOf = (chat: ChatDto): string => w.engine.view(chat.conversationId).state;
const folderOf = (chat: ChatDto): string => takeoverFolderOf(w.dataDir, chat.conversationId);
const notices = (chat: ChatDto): string[] =>
  listItems(w.state.db, chat.conversationId)
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => JSON.stringify(i.body));

/** A chat with one finished turn, so there is an agent session to resume. */
async function talked(): Promise<ChatDto> {
  const chat = w.open();
  // Held off the folder by 10db's own git work, so the session stays warm and the turn is read only.
  const token = w.folderHold.reserveGit(w.project.id, 'warming up');
  w.chat.send(chat.conversationId, { text: 'Hello', ...say });
  await w.engine.settled(chat.conversationId);
  if (token.reserved) w.folderHold.releaseGit(token.token);
  expect(getConversation(w.state.db, chat.conversationId).providerSessionId).not.toBeNull();
  return chat;
}

describe('Open in Terminal', () => {
  it('with Copy the Command takes the chat, opens no window and answers the line', async () => {
    w = chatWorld();
    const chat = await talked();
    const answer = await w.takeover.open(chat.conversationId);
    expect(stateOf(chat)).toBe('taken_over');
    expect(w.opened).toEqual([]);
    expect(answer.line).toMatch(/^\/bin\/sh -c '/);
    expect(answer.app).toBe('copy');
    const files = readdirSync(folderOf(chat));
    const script = files.find((f) => f.endsWith('.command'));
    expect(script).toBeDefined();
    const path = join(folderOf(chat), script ?? '');
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8').split('\n').slice(0, 2)).toEqual(['#!/bin/sh', 'rm -- "$0"']);
    const mcp = files.find((f) => f.startsWith('mcp-'));
    expect(serversIn(join(folderOf(chat), mcp ?? ''))).toEqual(['docs']);
    expect(w.takeover.takeoverOf(chat.conversationId)).toMatchObject({ app: 'copy' });
  });

  it('holds Your folder: 10db’s git work waits, naming the chat in the terminal', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.takeover.open(chat.conversationId);
    const git = w.folderHold.reserveGit(w.project.id, 'a switch back');
    expect(git.reserved).toBe(false);
  });

  it('with a terminal app hands the script to the opener and keeps the line to itself', async () => {
    w = chatWorld();
    w.terminal.app = 'terminal';
    const chat = await talked();
    const answer = await w.takeover.open(chat.conversationId);
    expect(answer.line).toBeNull();
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]?.app).toBe('terminal');
    expect(existsSync(w.opened[0]?.script ?? '')).toBe(true);
  });

  it('gives the chat back with no notice, and removes the files, when the terminal does not open', async () => {
    w = chatWorld();
    w.terminal.app = 'iterm';
    w.terminal.openerFails = new UpstreamError("iTerm isn't installed or didn't open.");
    const chat = await talked();
    const before = notices(chat);
    await expect(w.takeover.open(chat.conversationId)).rejects.toThrow(UpstreamError);
    expect(stateOf(chat)).toBe('idle_cold');
    expect(notices(chat)).toEqual(before);
    expect(existsSync(folderOf(chat))).toBe(false);
    expect(w.takeover.takeoverOf(chat.conversationId)).toBeNull();
    expect(w.folderHold.reserveGit(w.project.id, 'free again').reserved).toBe(true);
  });

  it('is refused with the holder’s words while 10db’s git work has the folder', async () => {
    w = chatWorld();
    const chat = await talked();
    expect(w.folderHold.reserveGit(w.project.id, 'a switch back').reserved).toBe(true);
    await expect(w.takeover.open(chat.conversationId)).rejects.toThrow(/Your folder is in use by/);
    expect(stateOf(chat)).toBe('idle_warm');
    expect(existsSync(folderOf(chat))).toBe(false);
  });

  it('is refused with no agent session yet', async () => {
    w = chatWorld();
    const chat = w.open();
    await expect(w.takeover.open(chat.conversationId)).rejects.toThrow('Send a message first');
  });

  it('is refused for an archived chat, after a restart too', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.chat.archive(chat.id);
    await expect(w.takeover.open(chat.conversationId)).rejects.toThrow(ConflictError);
    // A restart: nothing in the new engine knows the chat was retired.
    const after = chatWorld({ over: w });
    try {
      await expect(after.takeover.open(chat.conversationId)).rejects.toThrow('archived');
      expect(after.engine.view(chat.conversationId).state).toBe('idle_cold');
    } finally {
      await after.engine.close();
    }
  });
});

describe('Again and Copy the Command', () => {
  it('make a fresh set each time, keeping the first until Hand Back', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.takeover.open(chat.conversationId);
    const mcpFiles = (): string[] =>
      readdirSync(folderOf(chat)).filter((f) => f.startsWith('mcp-'));
    const [first] = mcpFiles();
    writeFileSync(join(folderOf(chat), first ?? ''), '{"mcpServers":{"evil":{}}}');
    const again = await w.takeover.open(chat.conversationId);
    const command = await w.takeover.command(chat.conversationId);
    expect(again.line).toMatch(/^\/bin\/sh -c/);
    expect(command.line).toMatch(/^\/bin\/sh -c/);
    const sets = mcpFiles();
    expect(sets).toHaveLength(3);
    for (const file of sets.filter((f) => f !== first))
      expect(serversIn(join(folderOf(chat), file))).toEqual(['docs']);
    await w.takeover.handBack(chat.conversationId);
    expect(existsSync(folderOf(chat))).toBe(false);
  });

  it('are refused for a chat that is not in the terminal', async () => {
    w = chatWorld();
    const chat = await talked();
    await expect(w.takeover.command(chat.conversationId)).rejects.toThrow('Not in your terminal');
  });
});

describe('Hand Back', () => {
  it('is refused for a chat that is not in the terminal', async () => {
    w = chatWorld();
    const chat = await talked();
    await expect(w.takeover.handBack(chat.conversationId)).rejects.toThrow('Not in your terminal');
  });

  it('puts the notice in the thread, gives the folder back and removes the files', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.takeover.open(chat.conversationId);
    await w.takeover.handBack(chat.conversationId);
    expect(stateOf(chat)).toBe('idle_cold');
    expect(notices(chat).join('')).toContain("aren't shown here");
    expect(existsSync(folderOf(chat))).toBe(false);
    expect(w.folderHold.reserveGit(w.project.id, 'free').reserved).toBe(true);
  });

  it('runs 10db’s waiting git work before a held message’s turn, and that turn writes', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.takeover.open(chat.conversationId);
    const before = notices(chat).length;
    // A message typed in 10db meanwhile is stored and held, taking nothing.
    w.chat.send(chat.conversationId, { text: 'while away', ...say });
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    // 10db's git work waits for the terminal.
    const controller = new AbortController();
    let token: symbol | null = null;
    const waiting = w.folderHold
      .reserveGitWhenFree(w.project.id, 'a switch back', controller.signal)
      .then((t) => {
        token = t;
      });
    await w.takeover.handBack(chat.conversationId);
    await waiting;
    // The git work holds the folder first; the held message is not running yet.
    const handed = token as symbol | null;
    expect(handed).not.toBeNull();
    expect(stateOf(chat)).toBe('idle_cold');
    if (handed !== null) w.folderHold.releaseGit(handed);
    await waitFor(() => w.folderHold.holdsTurn(chat.id));
    await w.engine.settled(chat.conversationId);
    // The turn held the folder, so it wrote rather than read.
    expect(notices(chat).slice(before).join('')).not.toContain('reads only');
  });
});

describe('the opening phase', () => {
  it('queues an archive behind the open, then archives with no holder left', async () => {
    w = chatWorld();
    const chat = await talked();
    const preparing = gate();
    w.terminal.prepareGate = preparing.promise;
    const opening = w.takeover.open(chat.conversationId);
    const archived = w.chat.archive(chat.id);
    preparing.release();
    await opening;
    await archived;
    expect(w.chat.get(chat.id).archivedAt).not.toBeNull();
    expect(existsSync(folderOf(chat))).toBe(false);
    expect(w.folderHold.reserveGit(w.project.id, 'free').reserved).toBe(true);
  });

  it('runs a Hand Back sent during the open after it, on the chain', async () => {
    w = chatWorld();
    const chat = await talked();
    const preparing = gate();
    w.terminal.prepareGate = preparing.promise;
    const opening = w.takeover.open(chat.conversationId);
    const handing = w.takeover.handBack(chat.conversationId);
    preparing.release();
    await opening;
    await handing;
    expect(stateOf(chat)).toBe('idle_cold');
    expect(existsSync(folderOf(chat))).toBe(false);
  });

  it('stop() ends an open that is preparing and leaves no files', async () => {
    w = chatWorld();
    const chat = await talked();
    const preparing = gate();
    w.terminal.prepareGate = preparing.promise;
    const opening = w.takeover.open(chat.conversationId).catch((e: unknown) => e);
    await waitFor(() => existsSync(folderOf(chat)));
    const stopped = w.takeover.stop();
    preparing.release();
    await stopped;
    expect(await opening).toBeInstanceOf(Error);
    expect(stateOf(chat)).toBe('idle_warm');
    expect(existsSync(folderOf(chat))).toBe(false);
  });
});

describe('the temp dirs a takeover keeps', () => {
  it('are named while the chat is in the terminal and not after Hand Back', async () => {
    w = chatWorld();
    const chat = await talked();
    const temp = join(w.dataDir, 'server-temp');
    expect(liveTakeoverTempDirs(w.state.db, w.dataDir).has(temp)).toBe(false);
    await w.takeover.open(chat.conversationId);
    expect(liveTakeoverTempDirs(w.state.db, w.dataDir).has(temp)).toBe(true);
    await w.takeover.handBack(chat.conversationId);
    expect(liveTakeoverTempDirs(w.state.db, w.dataDir).has(temp)).toBe(false);
  });
});

describe('archiving a chat in the terminal', () => {
  it('releases the folder, serves the waiting git work and removes the files', async () => {
    w = chatWorld();
    const chat = await talked();
    await w.takeover.open(chat.conversationId);
    const waiting = w.folderHold.reserveGitWhenFree(w.project.id, 'a switch back');
    await w.chat.archive(chat.id);
    w.folderHold.releaseGit(await waiting);
    expect(existsSync(folderOf(chat))).toBe(false);
    expect(w.takeover.takeoverOf(chat.conversationId)).toBeNull();
  });
});

describe('a restart', () => {
  it('removes the files of a chat that is not in the terminal, and keeps those of one that is', async () => {
    w = chatWorld();
    const kept = await talked();
    await w.takeover.open(kept.conversationId);
    const lost = await talked();
    // The daemon died while `lost` was opening: its files exist, its state says idle.
    await w.takeover.open(lost.conversationId);
    await w.takeover.handBack(lost.conversationId);
    const after = chatWorld({ over: w });
    try {
      mkdirsFor(after, lost);
      after.takeover.recover();
      expect(existsSync(folderOf(lost))).toBe(false);
      expect(existsSync(folderOf(kept))).toBe(true);
      expect(after.takeover.takeoverOf(kept.conversationId)).toMatchObject({ app: 'copy' });
    } finally {
      await after.engine.close();
    }
  });
});

function mkdirsFor(world: ChatWorld, chat: ChatDto): void {
  const folder = takeoverFolderOf(world.dataDir, chat.conversationId);
  writeFileSyncDeep(join(folder, 'mcp-x.json'));
}

function writeFileSyncDeep(path: string): void {
  // Made by the service's own folder routine's neighbour: the same real directories.
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, '{}');
}

describe('the popover’s preview', () => {
  it('lists the changed settings files, the folder hold and the refusal', async () => {
    w = chatWorld();
    const chat = await talked();
    w.terminal.changed = ['.claude/settings.json', 'src/a.ts'];
    const preview = await w.takeover.preview(chat.conversationId);
    expect(preview.refusal).toBeNull();
    expect(preview.notes).toContain('Your folder is held until you hand back.');
    expect(preview.notes.join('\n')).toContain('.claude/settings.json');
    expect(preview.notes.join('\n')).not.toContain('src/a.ts');
    w.folderHold.reserveGit(w.project.id, 'a switch back');
    expect((await w.takeover.preview(chat.conversationId)).refusal).toMatch(/in use by/);
  });
});
