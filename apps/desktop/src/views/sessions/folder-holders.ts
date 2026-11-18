import type { ChatDto, FolderDto, FolderHolderView } from '@10db/contracts';

/** The daemon writes a branch name in backticks; the lines here are plain text. */
const wordsOf = (holder: FolderHolderView): string => holder.words.replaceAll('`', '');

/** The holders that keep this chat's turn from writing, each as a sentence part; empty when none does. */
export function keepingHolders(chat: ChatDto | null, folder: FolderDto | null): readonly string[] {
  return (folder?.holders ?? [])
    .filter((holder) => holder.chatId !== chat?.id && holder.keepsChatOut)
    .map(wordsOf);
}
