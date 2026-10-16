export type GitVerdict = { readonly deny: string } | null;

/** Verbs that only read. Everything not listed here (and not `push` or `branch`) is refused. */
const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'ls-tree',
  'rev-list',
]);
const BRANCH_LISTING = new Set(['-a', '-r', '--list', '-v', '-vv', '--show-current']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
/** Global options that point git at another repository or change what config says. */
const REDIRECTING_OPTIONS = ['--git-dir', '--work-tree', '--namespace', '--config-env'];
const DANGEROUS_PUSH_FLAGS = new Set(['--delete', '--mirror', '--all', '--prune']);

/** Read-only verbs still write files or run programs through a few options. */
function readOnlySideEffects(verb: string, args: readonly string[]): GitVerdict {
  const writesFile = args.some((a) => a === '--output' || a.startsWith('--output='));
  const runsPager =
    verb === 'grep' &&
    args.some((a) => a.startsWith('-O') || a.startsWith('--open-files-in-pager'));
  if (writesFile) return { deny: 'git --output writes a file and is not allowed.' };
  if (runsPager) return { deny: 'git grep -O runs a program and is not allowed.' };
  return null;
}

function pushVerdict(args: readonly string[]): GitVerdict {
  for (const a of args) {
    const shortGroup = /^-[a-zA-Z]+$/.test(a) && /[fd]/.test(a);
    if (shortGroup || a.startsWith('--force') || DANGEROUS_PUSH_FLAGS.has(a)) {
      return { deny: 'Force pushes, remote deletes, mirrors and push --all are never allowed.' };
    }
    if (!a.startsWith('-') && (a.startsWith('+') || a.startsWith(':'))) {
      return { deny: 'Force pushes and remote deletes are never allowed.' };
    }
  }
  const targets = args
    .filter((a) => !a.startsWith('-'))
    .slice(1)
    .map((ref) => (ref.split(':').at(-1) ?? ref).replace(/^refs\//, '').replace(/^heads\//, ''));
  if (targets.some((t) => PROTECTED_BRANCHES.has(t))) {
    return { deny: 'Pushing to a protected branch is never allowed.' };
  }
  return null;
}

/**
 * Git in a managed session is an allowlist: read-only verbs, branch listing and a checked
 * `push`. Anything else changes the shared checkout or its config; commits go through the
 * 10db commit tool.
 */
export function gitVerdict(words: readonly string[]): GitVerdict {
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const flag = words[i] ?? '';
    if (REDIRECTING_OPTIONS.some((o) => flag === o || flag.startsWith(`${o}=`))) {
      return { deny: `git ${flag} points git at another repository or config and is not allowed.` };
    }
    if (flag === '-c') {
      return { deny: 'git -c can run commands through config and is not allowed.' };
    }
    i += flag === '-C' ? 2 : 1;
  }
  const verb = words[i] ?? '';
  const args = words.slice(i + 1);
  if (verb === '') return null;
  if (READ_ONLY_GIT.has(verb)) return readOnlySideEffects(verb, args);
  if (verb === 'commit') {
    return {
      deny: 'Direct git commit is not allowed. Use the 10db commit tool with explicit paths.',
    };
  }
  if (verb === 'branch') {
    return args.every((a) => BRANCH_LISTING.has(a))
      ? null
      : { deny: 'Creating or deleting branches is not allowed in the shared checkout.' };
  }
  if (verb === 'push') return pushVerdict(args);
  return {
    deny: `git ${verb} is not allowed. Only read-only git and push are allowed; commit through the 10db commit tool.`,
  };
}
