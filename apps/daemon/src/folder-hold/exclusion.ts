import {
  FolderAsker,
  FolderHolderKind,
  FolderLimit,
  FolderOutcome,
  type FolderHolderDto,
} from '@10db/contracts';

type Row = Record<FolderAsker, FolderOutcome>;

/**
 * What each holder does to each asker (sessions spec §7.3). Attended holders (a chat's turn, a takeover) share
 * with each other; only 10db's own writers exclude a chat, and a chat excludes them in turn.
 */
// A lane or a pass does not exclude 10db's git work here: the callers keep today's checks for them
// (`lanesInProjectCheckout`, `passHoldingFolder`), and a batch's own row must never block its cut or switch back.
const TABLE: Record<FolderHolderKind, Row> = {
  [FolderHolderKind.Lane]: {
    [FolderAsker.LaneStart]: FolderOutcome.Shares,
    [FolderAsker.GitWork]: FolderOutcome.Shares,
    [FolderAsker.ChatTurn]: FolderOutcome.ReadsOrWaits,
    [FolderAsker.Takeover]: FolderOutcome.Refused,
  },
  [FolderHolderKind.PassOpen]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Shares,
    [FolderAsker.ChatTurn]: FolderOutcome.ReadsOrWaits,
    [FolderAsker.Takeover]: FolderOutcome.Refused,
  },
  [FolderHolderKind.PassClosed]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Shares,
    [FolderAsker.ChatTurn]: FolderOutcome.Shares,
    [FolderAsker.Takeover]: FolderOutcome.Shares,
  },
  [FolderHolderKind.GitWork]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Waits,
    [FolderAsker.ChatTurn]: FolderOutcome.ReadsOrWaits,
    [FolderAsker.Takeover]: FolderOutcome.Refused,
  },
  [FolderHolderKind.ChatTurn]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Waits,
    [FolderAsker.ChatTurn]: FolderOutcome.Shares,
    [FolderAsker.Takeover]: FolderOutcome.Shares,
  },
  // A chat that waits for the folder has the builder at the screen: a lane's first start yields to it, and
  // 10db's git work runs because it moves nothing a parked message depends on.
  [FolderHolderKind.WaitingChat]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Shares,
    [FolderAsker.ChatTurn]: FolderOutcome.Shares,
    [FolderAsker.Takeover]: FolderOutcome.Shares,
  },
  [FolderHolderKind.Takeover]: {
    [FolderAsker.LaneStart]: FolderOutcome.Waits,
    [FolderAsker.GitWork]: FolderOutcome.Waits,
    [FolderAsker.ChatTurn]: FolderOutcome.Shares,
    [FolderAsker.Takeover]: FolderOutcome.Shares,
  },
};

/** What `holder` does to `asker`. */
export function exclusion(holder: FolderHolderKind, asker: FolderAsker): FolderOutcome {
  return TABLE[holder][asker];
}

/** The limits a holder puts on a chat that holds the folder anyway. */
export function limitsOf(holder: FolderHolderKind): readonly FolderLimit[] {
  return holder === FolderHolderKind.PassClosed ? [FolderLimit.FolderGitUntilMerge] : [];
}

function quoted(name: string): string {
  return `‘${name}’`;
}

/** The holder as a sentence part: "the task ‘Bump vite’ and 2 more", "the pass ‘P’ (until its pull request merges)". */
export function holderWords(holder: FolderHolderDto): string {
  switch (holder.kind) {
    case FolderHolderKind.Lane:
      return holder.more > 0
        ? `the task ${quoted(holder.name)} and ${String(holder.more)} more`
        : `the task ${quoted(holder.name)}`;
    case FolderHolderKind.PassOpen:
      return `the pass ${quoted(holder.name)}`;
    case FolderHolderKind.PassClosed:
      return `the pass ${quoted(holder.name)} (until its pull request merges)`;
    case FolderHolderKind.GitWork:
      return `10db ${holder.what ?? 'working in Your folder'}`;
    case FolderHolderKind.ChatTurn:
    case FolderHolderKind.WaitingChat:
      return `the chat ${quoted(holder.name)}`;
    case FolderHolderKind.Takeover:
      return `the chat ${quoted(holder.name)} in your terminal`;
  }
}
