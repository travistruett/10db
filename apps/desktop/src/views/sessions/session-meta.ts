import { ChatGitStep, WorkPlace, type ChatWorkStateDto } from '@10db/contracts';

export interface SessionMetaInput {
  readonly projectName: string;
  /** Where the session works; null while it only reads. */
  readonly place: WorkPlace | null;
  /** The branch it is moving to, from the chat row, while the move runs. */
  readonly movingTo: string | null;
  /** What the daemon read from the session's root; absent until read. */
  readonly state: ChatWorkStateDto | undefined;
  /** When the session went to the builder's terminal, as the builder reads it ("09:41"); null otherwise. */
  readonly terminalSince: string | null;
  /** The terminal holds the session. */
  readonly inTerminal: boolean;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** A pull request's checks in a few words, which the title row and the Merge button share. */
export function checksWords(checks: { passed: number; total: number; failing: number }): string {
  if (checks.failing > 0) return `${plural(checks.failing, 'check', 'checks')} failing`;
  if (checks.total > 0 && checks.passed < checks.total)
    return `checks running · ${String(checks.passed)}/${String(checks.total)}`;
  return 'checks passing';
}

/**
 * The dim line after the title (sessions spec §6.5), in git's words: where the session works, what changed,
 * and where the change has got to.
 */
export function sessionMeta(input: SessionMetaInput): string {
  const { projectName, place, state, movingTo } = input;
  if (input.inTerminal)
    return input.terminalSince === null
      ? 'in your terminal'
      : `in your terminal since ${input.terminalSince}`;
  if (place === WorkPlace.Moving)
    return movingTo === null ? 'moving to a new branch' : `moving to ${movingTo}`;
  if (place === WorkPlace.Choosing) return `${projectName} · waiting for your choice`;
  if (place === null) return `${projectName} · no changes yet`;
  const where = state?.branch ?? state?.baseBranch ?? null;
  const parts: string[] = where === null ? [] : [`on ${where}`];
  if (state === undefined) return parts.join(' · ');
  const pr = state.pullRequest;
  if (pr?.merged === true) {
    return [...parts, `merged into ${state.baseBranch ?? 'the base branch'}`].join(' · ');
  }
  const dirty = state.dirtyFiles;
  if (dirty > 0) {
    const changed = plural(dirty, 'file', 'files') + ' changed';
    parts.push(place === WorkPlace.Branch ? `${changed}, not committed` : changed);
  }
  if (pr !== null) parts.push(`pull request #${String(pr.number)}, ${checksWords(pr.checks)}`);
  else if (state.ahead > 0)
    // A project that merges locally has no pull request for the commits to be missing from.
    parts.push(
      plural(state.ahead, 'commit', 'commits') +
        (state.next === ChatGitStep.MergeLocal
          ? ` not merged into ${state.baseBranch ?? 'the base branch'}`
          : ' not in a pull request'),
    );
  else if (dirty === 0)
    // A branch that has been merged looks like one that was just cut, so it says where it stands, not "yet".
    parts.push(
      place === WorkPlace.Branch && state.baseBranch !== null
        ? `nothing ahead of ${state.baseBranch}`
        : 'no changes yet',
    );
  return parts.join(' · ');
}
