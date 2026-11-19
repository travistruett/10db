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
 * The strip's line under the composer (sessions spec §6.5), in git's words: the project, where the session
 * works and where its change has got to. How much changed is the strip's count, so the line leaves it out.
 */
export function sessionMeta(input: SessionMetaInput): string {
  const { projectName, place, state, movingTo } = input;
  const parts: string[] = projectName === '' ? [] : [projectName];
  const line = (...more: string[]): string => [...parts, ...more].join(' · ');
  if (input.inTerminal)
    return line(
      input.terminalSince === null
        ? 'in your terminal'
        : `in your terminal since ${input.terminalSince}`,
    );
  if (place === WorkPlace.Moving)
    return line(movingTo === null ? 'moving to a new branch' : `moving to ${movingTo}`);
  if (place === WorkPlace.Choosing) return line('waiting for your choice');
  if (place === null) return line();
  const where = state?.branch ?? state?.baseBranch ?? null;
  if (where !== null) parts.push(`on ${where}`);
  if (state === undefined) return line();
  const pr = state.pullRequest;
  if (pr?.merged === true) return line(`merged into ${state.baseBranch ?? 'the base branch'}`);
  // Uncommitted files on a branch are said even beside a pull request: Commit is the next step either way.
  if (state.dirtyFiles > 0 && place === WorkPlace.Branch) parts.push('not committed');
  if (pr !== null) return line(`pull request #${String(pr.number)}, ${checksWords(pr.checks)}`);
  if (state.ahead > 0)
    // A project that merges locally has no pull request for the commits to be missing from.
    return line(
      plural(state.ahead, 'commit', 'commits') +
        (state.next === ChatGitStep.MergeLocal
          ? ` not merged into ${state.baseBranch ?? 'the base branch'}`
          : ' not in a pull request'),
    );
  if (state.dirtyFiles === 0 && place === WorkPlace.Branch && state.baseBranch !== null)
    // A branch that has been merged looks like one that was just cut, so it says where it stands.
    return line(`nothing ahead of ${state.baseBranch}`);
  return line();
}
