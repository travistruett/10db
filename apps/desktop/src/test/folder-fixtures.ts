import {
  FolderDto,
  FolderHolderKind,
  FolderHolderView,
  mintId,
  type ChatId,
  type ProjectId,
} from '@10db/contracts';

// Who holds Your folder, as the daemon's `GET /projects/:id/folder` says it. Every DTO is parsed with its
// contract.

/** The words the daemon gives a holder, as a sentence part. */
function wordsOf(kind: FolderHolderKind, name: string, more: number, what: string | null): string {
  switch (kind) {
    case FolderHolderKind.Lane:
      return `the task ‘${name}’${more > 0 ? ` and ${String(more)} more` : ''}`;
    case FolderHolderKind.PassOpen:
      return `the pass ‘${name}’`;
    case FolderHolderKind.PassClosed:
      return `the pass ‘${name}’ (until its pull request merges)`;
    case FolderHolderKind.GitWork:
      return `10db ${what ?? 'working in Your folder'}`;
    case FolderHolderKind.Takeover:
      return `the chat ‘${name}’ in your terminal`;
    case FolderHolderKind.ChatTurn:
    case FolderHolderKind.WaitingChat:
      return `the chat ‘${name}’`;
  }
}

const KEEPS_CHAT_OUT: ReadonlySet<FolderHolderKind> = new Set([
  FolderHolderKind.Lane,
  FolderHolderKind.PassOpen,
  FolderHolderKind.GitWork,
]);

/** A holder of Your folder with the words that name it. */
export function folderHolder(
  kind: FolderHolderKind,
  name: string,
  opts: {
    readonly more?: number;
    readonly chatId?: ChatId | null;
    readonly what?: string | null;
  } = {},
): FolderHolderView {
  const more = opts.more ?? 0;
  const what = opts.what ?? null;
  return FolderHolderView.parse({
    kind,
    name,
    more,
    chatId: opts.chatId ?? null,
    what,
    words: wordsOf(kind, name, more, what),
    keepsChatOut: KEEPS_CHAT_OUT.has(kind),
  });
}

/** Your folder as `GET /projects/:id/folder` answers: free, on `main`, unless the test says otherwise. */
export function folderDto(
  overrides: Partial<FolderDto> & { readonly projectId?: ProjectId } = {},
): FolderDto {
  const holders = overrides.holders ?? [];
  const closed = holders.find((h) => h.kind === FolderHolderKind.PassClosed);
  return FolderDto.parse({
    projectId: mintId('Project'),
    branch: 'main',
    holders,
    limits: closed === undefined ? [] : ['folder_git_until_merge'],
    limitPass: closed?.name ?? null,
    pendingOpen: null,
    ...overrides,
  });
}
