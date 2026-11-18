import type { ChatDto, FolderDto, FolderHolderView } from '@10db/contracts';

function andJoin(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

/** The daemon writes a branch name in backticks; the lines here are plain text. */
const wordsOf = (holder: FolderHolderView): string => holder.words.replaceAll('`', '');

/** The holders that keep this chat's turn from writing, as a sentence part; null when none does. */
export function keepingWords(chat: ChatDto | null, folder: FolderDto | null): string | null {
  const keeping = (folder?.holders ?? []).filter(
    (holder) => holder.chatId !== chat?.id && holder.keepsChatOut,
  );
  return keeping.length === 0 ? null : andJoin(keeping.map(wordsOf));
}
