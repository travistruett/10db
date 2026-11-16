import { FolderHolderKind, type FolderDto } from '@10db/contracts';

// Sessions spec §7.3 (B10): a pass refused only because chats' turns hold Your folder offers two ways out,
// stopping those turns or waiting for them to end. A lane, a takeover, 10db's git work or another pass holds it
// for longer than a turn, so those refusals offer neither.

/** The holders whose turn the builder may stop or wait for: every holder of Your folder is a chat's turn. */
export function whenBusyChats(folder: FolderDto | null): string | null {
  if (folder === null) return null;
  const holders = folder.holders.filter((h) => h.kind !== FolderHolderKind.WaitingChat);
  if (holders.length === 0 || holders.some((h) => h.kind !== FolderHolderKind.ChatTurn))
    return null;
  return holders.map((h) => h.words).join(' and ');
}
