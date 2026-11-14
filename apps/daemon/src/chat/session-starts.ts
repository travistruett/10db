import { SessionStartKind, type SessionStartDto } from '@10db/contracts';

// UI spec §6.2: Start from offers at most three prompts, each built by a rule from one fact about the
// project. A rule with no fact offers nothing; none is a nudge.

/** Most characters of a failed task's title a prompt names. */
const TITLE_MAX = 60;

export interface StartFacts {
  readonly failedTask: { readonly title: string } | null;
  readonly baseCommits: { readonly base: string; readonly count: number } | null;
  readonly recentArea: string | null;
}

const cut = (text: string): string =>
  text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`;

export function sessionStarts(facts: StartFacts): SessionStartDto[] {
  const starts: SessionStartDto[] = [];
  if (facts.failedTask !== null)
    starts.push({
      kind: SessionStartKind.FailedTask,
      text: `Why did “${cut(facts.failedTask.title)}” fail?`,
    });
  if (facts.baseCommits !== null && facts.baseCommits.count > 0)
    starts.push({
      kind: SessionStartKind.BaseCommits,
      text: `What changed on ${facts.baseCommits.base} since yesterday?`,
    });
  if (facts.recentArea !== null)
    starts.push({ kind: SessionStartKind.RecentArea, text: `How does ${facts.recentArea} work?` });
  return starts;
}
