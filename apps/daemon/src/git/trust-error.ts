import type { CheckoutPin } from './checkout-pin';

export const GitTrustFailure = {
  /** A lane-writable config file sets a key the daemon's fetch or push does not accept. */
  Config: 'config',
  /** The checkout's git dir or common dir is not the one the daemon pinned. */
  Moved: 'moved',
  /** A git dir offered for trust lies where a lane can write: in the checkout or a lane temp dir. */
  Writable: 'writable',
  /** HEAD is not on the branch the commit is for. */
  Branch: 'branch',
  /** The branch ref is a symbolic ref, or moved while the commit ran. */
  Ref: 'ref',
  /** The object store borrows objects from another repository. */
  Alternates: 'alternates',
  /** An attributes file sits in the git dir, where turning attributes off can't reach it. */
  Attributes: 'attributes',
  /** origin's URL is not the one the daemon pinned. */
  Origin: 'origin',
  /** origin's URL carries credentials or doesn't parse cleanly. */
  Remote: 'remote',
  /** A path needs a filter (Git LFS, for one), which the daemon never runs. */
  Filter: 'filter',
  /** A path is a submodule or holds an embedded repository, whose own git the daemon never runs. */
  Embedded: 'embedded',
  /** A path under 10db's worktree root that 10db made no worktree at. */
  Unpinned: 'unpinned',
} as const;
export type GitTrustFailure = (typeof GitTrustFailure)[keyof typeof GitTrustFailure];

/** A config key the daemon refused, and the file it was read from. */
export interface RefusedKey {
  readonly key: string;
  readonly file: string;
}

export type GitTrustDetail =
  | { readonly kind: typeof GitTrustFailure.Config; readonly keys: readonly RefusedKey[] }
  | {
      readonly kind: typeof GitTrustFailure.Moved;
      readonly pinned: string;
      readonly found: string;
      /** The checkout as it was found, which the builder's Trust answer pins if it still holds. */
      readonly candidate: CheckoutPin;
    }
  | { readonly kind: typeof GitTrustFailure.Writable; readonly gitDir: string }
  | {
      readonly kind: typeof GitTrustFailure.Branch;
      readonly expected: string;
      readonly found: string | null;
      /** True when the commit landed on `expected` and HEAD moved meanwhile. */
      readonly committed: boolean;
    }
  | {
      readonly kind: typeof GitTrustFailure.Ref;
      readonly ref: string;
      readonly reason: 'symbolic' | 'raced';
    }
  | { readonly kind: typeof GitTrustFailure.Alternates; readonly file: string }
  | { readonly kind: typeof GitTrustFailure.Attributes; readonly file: string }
  | {
      readonly kind: typeof GitTrustFailure.Origin;
      readonly direction: 'fetch' | 'push';
      readonly pinned: string | null;
      readonly found: string | null;
      /** The checkout as it was found, which the builder's Trust answer pins if it still holds. */
      readonly candidate: CheckoutPin;
    }
  | {
      readonly kind: typeof GitTrustFailure.Remote;
      readonly direction: 'fetch' | 'push';
      /** Why the URL was refused, never the URL itself, which may hold a secret. */
      readonly why: string;
    }
  | {
      readonly kind: typeof GitTrustFailure.Filter;
      readonly paths: readonly { readonly path: string; readonly filter: string }[];
    }
  | { readonly kind: typeof GitTrustFailure.Embedded; readonly path: string }
  | { readonly kind: typeof GitTrustFailure.Unpinned };

function describe(repo: string, detail: GitTrustDetail): string {
  switch (detail.kind) {
    case GitTrustFailure.Config:
      return `10db won't fetch or push in ${repo}: its config sets ${detail.keys.map((k) => k.key).join(', ')}`;
    case GitTrustFailure.Moved:
      return `10db won't run git in ${repo}: its git dir is ${detail.found}, not ${detail.pinned} as 10db recorded`;
    case GitTrustFailure.Writable:
      return `10db won't trust ${repo}: its git dir ${detail.gitDir} lies where a lane can write`;
    case GitTrustFailure.Branch: {
      const on = detail.found ?? 'a detached HEAD';
      return detail.committed
        ? `10db committed on ${detail.expected} in ${repo}, but HEAD moved to ${on} while it ran`
        : `10db won't commit in ${repo}: the checkout is on ${on}, the lane's branch is ${detail.expected}`;
    }
    case GitTrustFailure.Ref:
      return detail.reason === 'symbolic'
        ? `10db won't commit in ${repo}: ${detail.ref} is a symbolic ref`
        : `10db's commit in ${repo} was not recorded: ${detail.ref} moved while it ran`;
    case GitTrustFailure.Alternates:
      return `10db won't run git in ${repo}: ${detail.file} borrows objects from another repository`;
    case GitTrustFailure.Attributes:
      return `10db won't run git in ${repo}: ${detail.file} sets attributes`;
    case GitTrustFailure.Origin:
      return `10db won't ${detail.direction} in ${repo}: origin's ${detail.direction} URL is ${detail.found ?? 'unset'}, not ${detail.pinned ?? 'unset'} as 10db recorded`;
    case GitTrustFailure.Remote:
      return `10db won't ${detail.direction} in ${repo}: origin's ${detail.direction} URL ${detail.why}`;
    case GitTrustFailure.Filter:
      return `10db won't commit or push in ${repo}: ${detail.paths
        .slice(0, 3)
        .map((p) => `${p.path} needs the ${p.filter} filter`)
        .join(', ')}${detail.paths.length > 3 ? ', …' : ''}`;
    case GitTrustFailure.Embedded:
      return `10db won't commit ${detail.path} in ${repo}: it is a submodule or holds a repository of its own`;
    case GitTrustFailure.Unpinned:
      return `10db won't run git in ${repo}: it lies under 10db's worktree root, but 10db made no worktree there`;
  }
}

/** The daemon's git refused to work in a checkout it does not trust. */
export class GitTrustError extends Error {
  override readonly name = 'GitTrustError';
  readonly repo: string;
  readonly detail: GitTrustDetail;
  constructor(repo: string, detail: GitTrustDetail) {
    super(describe(repo, detail));
    this.repo = repo;
    this.detail = detail;
  }
}
