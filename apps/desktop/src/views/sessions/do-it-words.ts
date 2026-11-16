import {
  ChatId,
  DoItPlace,
  ProjectId,
  type ChangedEntryDto,
  type DoItPreviewDto,
} from '@10db/contracts';

// Sessions UI §8.1: the words the Do It sheet says for each place, before the builder presses it.

/** What the builder reads for a place. */
export function placeLabel(place: DoItPlace): string {
  switch (place) {
    case DoItPlace.Worktree:
      return 'Separate copy';
    case DoItPlace.Here:
      return 'Your folder, as a pass';
  }
}

/** Where the place works and how it lands, in backticks the sheet draws as code. */
export function placeLine(
  place: DoItPlace,
  project: { readonly name: string; readonly baseBranch: string; readonly local: boolean },
): string {
  switch (place) {
    case DoItPlace.Worktree:
      return `An ordinary task in its own copy, on a new branch. It lands by ${project.name}'s delivery: the gate, a review, and a pull request.`;
    case DoItPlace.Here:
      return `A pass of one on its own branch from \`${project.baseBranch}\`. Sign Off lands each turn's work; Close Pass… opens one pull request, and \`${project.baseBranch}\` fast-forwards to it when ${project.local ? 'the pass closes' : 'it merges'}. Your folder is held until then.`;
  }
}

/** The copy's start: its base, and the commits Your folder's branch has that the base lacks. */
export function startLine(preview: Pick<DoItPreviewDto, 'base' | 'leftOut'>): string | null {
  if (preview.base === null) return null;
  const { leftOut } = preview;
  if (leftOut === null || leftOut.count === 0) return `Starts from \`${preview.base}\`.`;
  const commits = leftOut.count === 1 ? 'commit' : 'commits';
  const have = leftOut.count === 1 ? 'lacks' : 'lack';
  return `Starts from \`${preview.base}\`. The ${String(leftOut.count)} ${commits} on \`${leftOut.branch}\` that \`${preview.base}\` ${have} stay out of it.`;
}

/** What happens to the files already changed in Your folder, by place. */
export function fateLine(place: DoItPlace): string {
  switch (place) {
    case DoItPlace.Worktree:
      return 'These stay in your folder. The task starts without them.';
    case DoItPlace.Here:
      return "These will be part of this task's work.";
  }
}

/** "7 files already changed in your folder:", the count including the files past the list. */
export function changedHeading(listed: number, more: number): string {
  const n = listed + more;
  return `${String(n)} ${n === 1 ? 'file' : 'files'} already changed in your folder:`;
}

/** The files the sheet lists before it folds the rest behind Show N More. */
export const CHANGED_SHOWN = 5;

/** The first files, and how many more the fold hides. */
export function changedShown(
  entries: readonly ChangedEntryDto[],
  expanded: boolean,
): { readonly shown: readonly ChangedEntryDto[]; readonly hidden: number } {
  if (expanded || entries.length <= CHANGED_SHOWN) return { shown: entries, hidden: 0 };
  return { shown: entries.slice(0, CHANGED_SHOWN), hidden: entries.length - CHANGED_SHOWN };
}

/** What the footer says happens to the chat, by place. */
export function chatFate(place: DoItPlace): string {
  switch (place) {
    case DoItPlace.Worktree:
      return "The task takes this chat's place. The chat becomes read-only.";
    case DoItPlace.Here:
      return 'The pass opens in its own tab. This chat stays open, and changes nothing while the pass holds your folder.';
  }
}

/** The dimmed line under a brief the chat made, by why the agent didn't. */
export function briefSourceLine(brief: DoItPreviewDto['brief'], label: string): string | null {
  if (brief.writing) return null;
  if (brief.source === 'agent') return `Brief · written by ${label} from this chat; edit freely`;
  switch (brief.reason) {
    case 'mid_turn':
      return 'The chat is mid-turn, so this brief is the chat so far.';
    case 'paused':
      return 'The account is paused, so this brief is the chat so far.';
    case 'timeout':
      return `${label} didn't write a brief in time, so this brief is the chat so far.`;
    case null:
      return null;
  }
}

/** Where a refusal's link goes. */
export type RefusalLink =
  | { readonly kind: 'workbench'; readonly projectId: ProjectId }
  | { readonly kind: 'board'; readonly projectId: ProjectId }
  | { readonly kind: 'session'; readonly chatId: ChatId };

const LINK = /^(workbench|board|session):(.+)$/;

/** The destination a refusal's `link` names, or null for none or one this window doesn't know. */
export function parseRefusalLink(link: string | null): RefusalLink | null {
  if (link === null) return null;
  const match = LINK.exec(link);
  const kind = match?.[1];
  const id = match?.[2];
  if (id === undefined) return null;
  if (kind === 'workbench' || kind === 'board') {
    const projectId = ProjectId.safeParse(id);
    return projectId.success ? { kind, projectId: projectId.data } : null;
  }
  if (kind === 'session') {
    const chatId = ChatId.safeParse(id);
    return chatId.success ? { kind, chatId: chatId.data } : null;
  }
  return null;
}

/** The link's label. */
export function linkLabel(link: RefusalLink): string {
  switch (link.kind) {
    case 'workbench':
      return 'Open UI Workbench';
    case 'board':
      return 'Open Board';
    case 'session':
      return 'Open Session';
  }
}
