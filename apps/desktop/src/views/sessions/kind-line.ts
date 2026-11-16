import {
  ConversationState,
  FolderHolderKind,
  type ChatDto,
  type FolderDto,
  type FolderHolderView,
} from '@10db/contracts';
import dayjs from 'dayjs';

/** The holders a chat shares the folder with: other chats, here or in a terminal. */
const SHARED_KINDS: ReadonlySet<FolderHolderKind> = new Set([
  FolderHolderKind.ChatTurn,
  FolderHolderKind.Takeover,
]);

function andJoin(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

/** The daemon writes a branch name in backticks; the lines here are plain text, as the free line's branch is. */
const wordsOf = (holder: FolderHolderView): string => holder.words.replaceAll('`', '');

/** The holders that keep this chat's turn from writing, as a sentence part; null when none does. */
export function keepingWords(chat: ChatDto | null, folder: FolderDto | null): string | null {
  const keeping = (folder?.holders ?? []).filter(
    (holder) => holder.chatId !== chat?.id && holder.keepsChatOut,
  );
  return keeping.length === 0 ? null : andJoin(keeping.map(wordsOf));
}

/**
 * The dimmed line under a session's title, saying what the session is and what it does to Your folder
 * (sessions UI spec §4). Until the folder is read, a chat reads the project. A chat in the builder's terminal
 * says since when, once `since` (an ISO time) is read.
 */
export function kindLine(
  chat: ChatDto,
  projectName: string,
  folder: FolderDto | null,
  since: string | null = null,
): string {
  if (chat.conversation.state === ConversationState.TakenOver)
    return since === null
      ? 'Chat · in your terminal'
      : `Chat · in your terminal since ${dayjs(since).format('HH:mm')}`;
  if (folder === null) return `Chat · reads ${projectName}`;
  const keeping = keepingWords(chat, folder);
  const parts: string[] = [];
  if (keeping !== null) parts.push(`reads only: Your folder is in use by ${keeping}`);
  else {
    const others = folder.holders.filter((holder) => holder.chatId !== chat.id);
    const alongside = others.filter((holder) => SHARED_KINDS.has(holder.kind));
    parts.push(folder.branch === null ? 'Your folder' : `Your folder · on ${folder.branch}`);
    if (alongside.length > 0) parts.push(`also in use by ${andJoin(alongside.map(wordsOf))}`);
  }
  if (folder.limitPass !== null)
    parts.push(
      `commits, branch moves and pulls wait until the pass ‘${folder.limitPass}’'s pull request merges`,
    );
  return `Chat · ${parts.join(' · ')}`;
}
