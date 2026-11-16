import { FolderHolderKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { whenBusyChats } from './when-busy';

describe('whenBusyChats', () => {
  const chat = folderHolder(FolderHolderKind.ChatTurn, 'Login fails');
  it.each([
    { name: 'a chat’s turn', holders: [chat], want: 'the chat ‘Login fails’' },
    {
      name: 'two chats’ turns',
      holders: [chat, folderHolder(FolderHolderKind.ChatTurn, 'Docs')],
      want: 'the chat ‘Login fails’ and the chat ‘Docs’',
    },
    { name: 'a lane', holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')], want: null },
    {
      name: 'a chat and a lane',
      holders: [chat, folderHolder(FolderHolderKind.Lane, 'Bump vite')],
      want: null,
    },
    {
      name: 'a takeover',
      holders: [folderHolder(FolderHolderKind.Takeover, 'Login fails')],
      want: null,
    },
    {
      name: 'git work',
      holders: [folderHolder(FolderHolderKind.GitWork, 'x', { what: 'merging' })],
      want: null,
    },
    {
      name: 'a chat’s turn with a message waiting',
      holders: [chat, folderHolder(FolderHolderKind.WaitingChat, 'Docs')],
      want: 'the chat ‘Login fails’',
    },
    { name: 'nothing', holders: [], want: null },
  ])('$name', ({ holders, want }) => {
    expect(whenBusyChats(folderDto({ holders }))).toBe(want);
  });
  it('is none before the folder is read', () => {
    expect(whenBusyChats(null)).toBeNull();
  });
});
