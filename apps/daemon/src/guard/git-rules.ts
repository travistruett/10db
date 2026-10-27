export type GitVerdict = { readonly deny: string } | null;

/** Verbs that only read. Everything not listed here (and not `branch`) is refused. */
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
/** Global options that point git at another repository or change what config says. */
const REDIRECTING_OPTIONS = ['--git-dir', '--work-tree', '--namespace', '--config-env'];

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

/**
 * Git in a managed session is an allowlist: read-only verbs and branch listing. Anything else
 * changes the shared checkout, its config or a remote; commits go through the 10db commit tool,
 * and only the daemon pushes, to the URL pinned for the project.
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
  if (verb === 'push') return { deny: 'Lanes never push; 10db pushes the work when it ships.' };
  return {
    deny: `git ${verb} is not allowed. Only read-only git is allowed; commit through the 10db commit tool.`,
  };
}
