import { FolderHolderKind } from '@10db/contracts';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { chatDto } from '../../test/chat-fixtures';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { kindLine } from './kind-line';

const chat = chatDto();

// The line under a session's title: what the chat is and what it does to Your folder.
describe('kindLine', () => {
  const rows: { name: string; folder: ReturnType<typeof folderDto> | null; line: string }[] = [
    { name: 'before the folder is read', folder: null, line: 'Chat · reads ampsio' },
    { name: 'a free folder', folder: folderDto(), line: 'Chat · Your folder · on main' },
    {
      name: 'a detached or unreadable branch',
      folder: folderDto({ branch: null }),
      line: 'Chat · Your folder',
    },
    {
      name: 'a task keeps the chat out',
      folder: folderDto({ holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')] }),
      line: 'Chat · reads only: Your folder is in use by the task ‘Bump vite’',
    },
    {
      name: 'a task and more tasks',
      folder: folderDto({
        holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite', { more: 2 })],
      }),
      line: 'Chat · reads only: Your folder is in use by the task ‘Bump vite’ and 2 more',
    },
    {
      name: 'a pass and 10db’s git work',
      folder: folderDto({
        holders: [
          folderHolder(FolderHolderKind.PassOpen, 'Settings pass'),
          folderHolder(FolderHolderKind.GitWork, '', {
            what: 'switching Your folder back to `main`',
          }),
        ],
      }),
      line: 'Chat · reads only: Your folder is in use by the pass ‘Settings pass’ and 10db switching Your folder back to main',
    },
    {
      name: 'another chat shares it',
      folder: folderDto({ holders: [folderHolder(FolderHolderKind.ChatTurn, 'Retry login')] }),
      line: 'Chat · Your folder · on main · also in use by the chat ‘Retry login’',
    },
    {
      name: 'a chat in a terminal shares it',
      folder: folderDto({ holders: [folderHolder(FolderHolderKind.Takeover, 'Retry login')] }),
      line: 'Chat · Your folder · on main · also in use by the chat ‘Retry login’ in your terminal',
    },
    {
      name: 'a closed pass limits commits',
      folder: folderDto({ holders: [folderHolder(FolderHolderKind.PassClosed, 'Settings pass')] }),
      line: "Chat · Your folder · on main · commits, branch moves and pulls wait until the pass ‘Settings pass’'s pull request merges",
    },
    {
      name: 'a task keeps the chat out while a closed pass limits git',
      folder: folderDto({
        holders: [
          folderHolder(FolderHolderKind.Lane, 'Bump vite'),
          folderHolder(FolderHolderKind.PassClosed, 'Settings pass'),
        ],
      }),
      line: "Chat · reads only: Your folder is in use by the task ‘Bump vite’ · commits, branch moves and pulls wait until the pass ‘Settings pass’'s pull request merges",
    },
    {
      name: 'a waiting chat is not using the folder',
      folder: folderDto({ holders: [folderHolder(FolderHolderKind.WaitingChat, 'Retry login')] }),
      line: 'Chat · Your folder · on main',
    },
    {
      name: 'the chat’s own turn is not another chat',
      folder: folderDto({
        holders: [folderHolder(FolderHolderKind.ChatTurn, 'x', { chatId: chat.id })],
      }),
      line: 'Chat · Your folder · on main',
    },
  ];

  it.each(rows)('$name', ({ folder, line }) => {
    expect(kindLine(chat, 'ampsio', folder)).toBe(line);
  });

  it.each([
    { name: 'its start unread', since: null, line: 'Chat · in your terminal' },
    {
      name: 'its start read',
      since: '2026-11-16T12:04:00.000Z',
      line: `Chat · in your terminal since ${dayjs('2026-11-16T12:04:00.000Z').format('HH:mm')}`,
    },
  ])('a chat in the builder’s terminal: $name', ({ since, line }) => {
    const taken = chatDto({ conversation: { state: 'taken_over' } });
    // The terminal holds the folder, which is no other holder's business here.
    expect(
      kindLine(
        taken,
        'ampsio',
        folderDto({ holders: [folderHolder(FolderHolderKind.Lane, 'x')] }),
        since,
      ),
    ).toBe(line);
  });
});
