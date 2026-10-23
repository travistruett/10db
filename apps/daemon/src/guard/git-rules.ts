import { Delivery } from '@10db/contracts';

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

/** Git accepts any unambiguous abbreviation of a long option, so `--open=x` means `--open-files-in-pager=x`. */
export function abbreviates(arg: string, option: string): boolean {
  const name = arg.split('=')[0] ?? arg;
  return name.startsWith('--') && name.length >= 3 && option.startsWith(name);
}

/** Read-only verbs still write files or run programs through a few options. */
function readOnlySideEffects(verb: string, args: readonly string[]): GitVerdict {
  if (args.some((a) => abbreviates(a, '--output'))) {
    return { deny: 'git --output writes a file and is not allowed.' };
  }
  // git grep bundles letters and context digits before -O (`-n1Osh`), so any short bundle
  // holding an O is denied rather than modelling the short-option grammar.
  if (
    verb === 'grep' &&
    args.some((a) => /^-[^-]*O/.test(a) || abbreviates(a, '--open-files-in-pager'))
  ) {
    return {
      deny: 'git grep -O runs a program and is not allowed. Any short option group containing O is refused; pass a pattern starting with O as its own argument, for example -e O.',
    };
  }
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
export function gitVerdict(words: readonly string[], delivery: Delivery): GitVerdict {
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
  if (verb === 'push')
    return delivery === Delivery.PullRequest
      ? { deny: '10db pushes when the batch ships; agents do not push in pull-request projects.' }
      : pushVerdict(args);
  return {
    deny: `git ${verb} is not allowed. Only read-only git and push are allowed; commit through the 10db commit tool.`,
  };
}
