import {
  FolderAsker,
  FolderHolderKind,
  FolderOutcome,
  type FolderDto,
  type FolderHolderDto,
  type ProjectId,
} from '@10db/contracts';
import { exclusion, holderWords, limitsOf } from './exclusion';

/**
 * Who holds a project's checkout, as the session bar and the composer read it: each holder with the words
 * that name it and whether a chat's turn is kept out, and the limits a closed pass puts on the folder git tools.
 */
export function folderView(
  projectId: ProjectId,
  branch: string | null,
  holders: readonly FolderHolderDto[],
): FolderDto {
  const limits = [...new Set(holders.flatMap((holder) => limitsOf(holder.kind)))];
  return {
    projectId,
    branch,
    holders: holders.map((holder) => ({
      ...holder,
      words: holderWords(holder),
      keepsChatOut: exclusion(holder.kind, FolderAsker.ChatTurn) !== FolderOutcome.Shares,
    })),
    limits,
    limitPass: holders.find((holder) => holder.kind === FolderHolderKind.PassClosed)?.name ?? null,
  };
}
