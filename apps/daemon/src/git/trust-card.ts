import type { CheckoutPin } from './checkout-pin';
import { GitTrustFailure, type GitTrustError } from './trust-error';

export interface TrustCard {
  readonly title: string;
  readonly body: string;
  /** One open card per checkout and cause, however many refusals fold into it. */
  readonly foldKey: string;
  /** The state the card offers to trust, exactly as the refusal found it; null when it offers none. */
  readonly candidate: CheckoutPin | null;
}

const RETRUST =
  'Look at it yourself first. If everything there is yours, answer Trust the checkout as it is now: 10db records the state this card describes and carries on. If the checkout changed again since, 10db refuses once more with a new card.';

/** `value` quoted for a POSIX shell, so a pasted command passes it as one word, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Values safe to put in a command the builder may paste: no quote, space, `$`, backtick or newline. */
const PASTE_SAFE = /^[A-Za-z0-9._/:@+=~,-]+$/;

/**
 * `value` as a markdown code span that shows it literally: control characters escaped as JSON
 * would, and a fence longer than any run of backticks inside.
 */
function codeSpan(value: string): string {
  const shown = JSON.stringify(value).slice(1, -1);
  const longest = Math.max(0, ...(shown.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${shown} ${fence}` : `${fence}${shown}${fence}`;
}

/**
 * How the builder removes the locked worktree at `path`, as git run in `checkout` (the main checkout,
 * or a linked worktree of the same repository), so it works wherever it is pasted: a command to paste
 * when both paths are plain, otherwise the command to type, naming each path as a code span.
 */
export function worktreeRemovalCommand(checkout: string, path: string): string {
  return PASTE_SAFE.test(checkout) && PASTE_SAFE.test(path)
    ? `git -C ${shellQuote(checkout)} worktree remove --force --force ${shellQuote(path)}`
    : `git worktree remove --force --force run in ${codeSpan(checkout)}, naming ${codeSpan(path)}`;
}

function body(error: GitTrustError): string {
  const { repo, detail } = error;
  const here = PASTE_SAFE.test(repo) ? ` in ${shellQuote(repo)}` : ` in ${codeSpan(repo)}`;
  switch (detail.kind) {
    case GitTrustFailure.Config: {
      const lines = detail.keys
        .map((k) => `- ${codeSpan(k.key)} in ${codeSpan(k.file)}`)
        .join('\n');
      const first = detail.keys[0];
      // A command to paste only when every value in it is plain; otherwise the builder types it.
      const pasted =
        first && PASTE_SAFE.test(first.file) && PASTE_SAFE.test(first.key)
          ? `git config --file ${shellQuote(first.file)} --unset-all ${shellQuote(first.key)}`
          : null;
      const how = pasted
        ? `for example ${pasted}`
        : 'with git config --unset-all, naming the file and key shown above';
      return `10db's fetch and push take no program or redirect from config a lane could have written.\n\n${lines}\n\nIf you set a key yourself and trust it, move it to your global config (~/.gitconfig). Otherwise remove it, ${how}. Then retry what stopped.`;
    }
    case GitTrustFailure.Moved:
      return `Something replaced the repository${here} after 10db recorded it; a lane can do that by moving .git. Until you decide, 10db's git won't touch it: lanes in this project can't commit and nothing ships. Check what git rev-parse --git-dir --git-common-dir prints there, and what is in it. ${RETRUST}`;
    case GitTrustFailure.Writable:
      return `${codeSpan(detail.gitDir)} is inside a project's checkout or a lane's temp dir, where a lane could plant hooks, config or refs that 10db's git would then use. 10db trusts a git dir only at .git in the checkout or outside every place a lane writes. Move the repository's git dir there${here} (git rev-parse --git-dir --git-common-dir shows where it is now), then retry what stopped.`;
    case GitTrustFailure.Branch:
      return detail.committed
        ? `The commit is on ${codeSpan(detail.expected)}, where it belongs, but the checkout is now on ${detail.found === null ? 'a detached HEAD' : codeSpan(detail.found)}. Switch back to ${codeSpan(detail.expected)}${here} before the lane goes on.`
        : `A lane may have switched branches; 10db commits only to the lane's branch. Switch back to ${codeSpan(detail.expected)}${here}, then let the lane retry its commit.`;
    case GitTrustFailure.Ref:
      return detail.reason === 'symbolic'
        ? `${codeSpan(detail.ref)} points at another branch, so a commit to it would land there. Recreate it as an ordinary branch (git branch -f)${here}, then let the lane retry its commit.`
        : `Something moved ${codeSpan(detail.ref)} while 10db committed, so 10db left it where it was. Look at its log${here}, then let the lane retry its commit.`;
    case GitTrustFailure.Attributes:
      return `10db's git reads no attributes, so no filter or line-ending conversion it doesn't trust can run, and ${codeSpan(detail.file)} is the one attributes file it can't switch off. Move what it sets into .gitattributes in the repository (or delete it if you didn't write it), then retry what stopped.`;
    case GitTrustFailure.Alternates:
      return `10db reads and writes only objects this repository holds. Remove ${codeSpan(detail.file)} (git repack -a -d first if you made it on purpose), then retry what stopped.`;
    case GitTrustFailure.Origin:
      return `10db ${detail.direction === 'fetch' ? 'fetches from' : 'pushes to'} the URL it recorded for origin, never one read from config a lane could have written. If you changed origin yourself, check it with git remote -v${here}. ${RETRUST}`;
    case GitTrustFailure.Remote:
      return `10db never sends credentials written into a remote URL, and fetches and pushes only to a URL that parses one way. Put the token where git keeps credentials instead: run gh auth login and then gh auth setup-git, use a credential helper, or switch origin to ssh (git@github.com:owner/repo.git) with git remote set-url origin${here}. Then retry what stopped.`;
    case GitTrustFailure.Filter:
      return `10db commits and pushes files exactly as they are and never runs a filter, so it can't commit these files or push a branch that needs one:\n\n${detail.paths
        .map((p) => `- ${codeSpan(p.path)} (${codeSpan(p.filter)})`)
        .join(
          '\n',
        )}\n\nCommit them, or push the branch, yourself. A repository that uses Git LFS can't ship through 10db yet.`;
    case GitTrustFailure.Embedded:
      return `${codeSpan(detail.path)} is a submodule or holds a repository of its own, whose git would run its own config and hooks. 10db never commits one; commit it yourself if it belongs in the change.`;
    case GitTrustFailure.Unpinned:
      // The main checkout isn't known here; git run in a linked worktree removes that worktree too.
      return `10db runs git under its worktree root only in worktrees it made, and it made none at ${codeSpan(repo)}. Nothing there is trusted and nothing there ships. If it is not yours, remove it with ${worktreeRemovalCommand(repo, repo)}.`;
  }
}

/**
 * What the card's fold key adds to the checkout and cause: the state a re-trust card offers, so a
 * new move or a new origin opens a new card rather than folding into one the builder already read.
 */
function foldSuffix(error: GitTrustError): string {
  const { detail } = error;
  switch (detail.kind) {
    case GitTrustFailure.Moved:
      return `:${detail.candidate.id}`;
    case GitTrustFailure.Origin:
      return `:${detail.direction}:${detail.found ?? ''}`;
    case GitTrustFailure.Remote:
      return `:${detail.direction}`;
    case GitTrustFailure.Writable:
      return `:${detail.gitDir}`;
    case GitTrustFailure.Config:
    case GitTrustFailure.Branch:
    case GitTrustFailure.Ref:
    case GitTrustFailure.Alternates:
    case GitTrustFailure.Attributes:
    case GitTrustFailure.Filter:
    case GitTrustFailure.Embedded:
    case GitTrustFailure.Unpinned:
      return '';
  }
}

/** The inbox card for a refusal: what was found and what the builder does about it. */
export function trustCard(error: GitTrustError): TrustCard {
  const { detail } = error;
  return {
    title: error.message,
    body: body(error),
    foldKey: `git-trust:${error.repo}:${detail.kind}${foldSuffix(error)}`,
    candidate:
      detail.kind === GitTrustFailure.Moved || detail.kind === GitTrustFailure.Origin
        ? detail.candidate
        : null,
  };
}
