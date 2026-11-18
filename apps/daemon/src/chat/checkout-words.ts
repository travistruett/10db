import { FolderHolderKind, type FolderHolderDto } from '@10db/contracts';

// What the title row and the bar say about whoever has the builder's checkout: whole sentences, built from the
// holder and the branch the checkout is on. `holderWords` in `folder-hold/` stays a fragment for the callers that
// place it inside a sentence of their own.

/** The kinds that refuse a title-row step at once; a chat's turn or 10db's git work only makes it wait. */
const REFUSING: ReadonlySet<FolderHolderKind> = new Set([
  FolderHolderKind.Lane,
  FolderHolderKind.PassOpen,
  FolderHolderKind.PassClosed,
  FolderHolderKind.Takeover,
]);

/** The first holder that refuses a step in the checkout outright, or undefined. */
export function blockingHolder(holders: readonly FolderHolderDto[]): FolderHolderDto | undefined {
  return holders.find((holder) => REFUSING.has(holder.kind));
}

/** The holder as a sentence: "A Board task is changing files on `main`." `branch` is the checkout's. */
export function checkoutHolderWords(holder: FolderHolderDto, branch: string | null): string {
  const on = branch === null ? 'in your checkout' : `on \`${branch}\``;
  switch (holder.kind) {
    case FolderHolderKind.Lane:
      return holder.more > 0
        ? `Board tasks are changing files ${on}.`
        : `A Board task is changing files ${on}.`;
    case FolderHolderKind.PassOpen:
      return `The pass ‘${holder.name}’ is changing files ${on}.`;
    case FolderHolderKind.PassClosed:
      return `The pass ‘${holder.name}’ has your checkout${branch === null ? '' : ` on \`${branch}\``} until its pull request merges.`;
    case FolderHolderKind.Takeover:
      return `The session ‘${holder.name}’ is in your terminal${branch === null ? '' : `, on \`${branch}\``}.`;
    case FolderHolderKind.ChatTurn:
    case FolderHolderKind.WaitingChat:
      return `The session ‘${holder.name}’ is changing files ${on}.`;
    case FolderHolderKind.GitWork:
      return `10db is ${holder.what ?? `working ${on}`}.`;
  }
}
