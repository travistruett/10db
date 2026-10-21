export type GhVerdict = { readonly deny: string } | null;

/** gh flags that take a value and may come before the command group. */
const LEADING_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
/** A group whose every subcommand only reads. */
const ANY = 'any';
/**
 * The gh commands an agent may run: reads only. Everything else is denied, so an alias (`gh m`),
 * an extension, `auth token`, `config set`, `workflow run` or a command gh adds later never runs
 * unseen. `pr checkout` is not a read: it switches the shared checkout's branch.
 */
const READS: ReadonlyMap<string, ReadonlySet<string> | typeof ANY> = new Map<
  string,
  ReadonlySet<string> | typeof ANY
>([
  ['pr', new Set(['view', 'list', 'checks', 'diff', 'status'])],
  ['repo', new Set(['view', 'list'])],
  ['issue', new Set(['view', 'list', 'status'])],
  ['run', new Set(['view', 'list'])],
  ['workflow', new Set(['view', 'list'])],
  ['auth', new Set(['status'])],
  ['search', ANY],
  ['status', ANY],
  ['help', ANY],
  ['version', ANY],
]);
/** gh api sends POST by default once any of these is given (gh help api). */
const FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];

/** The command group after `gh` and where it sits, skipping leading flags and their values. */
function commandGroup(words: readonly string[]): { group: string | undefined; at: number } {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (LEADING_VALUE_FLAGS.has(w)) i += 1;
    else if (!w.startsWith('-')) return { group: w, at: i };
  }
  return { group: undefined, at: words.length };
}

/** The first word after the group that is not a flag: `merge` in `gh pr merge 12`. */
function verbAfter(words: readonly string[], at: number): string | undefined {
  return words.slice(at + 1).find((w) => !w.startsWith('-'));
}

function isFieldFlag(arg: string): boolean {
  return (
    FIELD_FLAGS.includes(arg) ||
    FIELD_FLAGS.some((f) => f.startsWith('--') && arg.startsWith(`${f}=`)) ||
    /^-[fF]./.test(arg)
  );
}

/** The method a `gh api` call sends: an explicit -X/--method, else POST with fields, else GET. */
function apiMethod(args: readonly string[]): string {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '-X' || a === '--method') {
      method = (args[i + 1] ?? '').toUpperCase();
      i += 1;
    } else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
    else if (isFieldFlag(a)) fields = true;
  }
  return method ?? (fields ? 'POST' : 'GET');
}

const ALLOWED =
  'Agents may run gh pr view, list, checks, diff and status; gh repo view and list; gh issue view, list and status; gh run and gh workflow view and list; gh search; gh status; gh auth status; gh help; gh --version; and gh api GET requests.';

/**
 * gh in a managed session only reads (batch delivery spec §7): 10db opens the pull request when a
 * batch ships, merging stays with the builder, and nothing changes GitHub or gh's own config.
 */
export function ghVerdict(words: readonly string[]): GhVerdict {
  const { group, at } = commandGroup(words);
  // Bare `gh`, `gh --help` and `gh --version` only print.
  if (group === undefined) return null;
  if (group === 'api') {
    // Every argument after `api`, so `-X POST` before or after the endpoint both count.
    const method = apiMethod(words.slice(at + 1));
    return method === 'GET'
      ? null
      : {
          deny: `gh api ${method} requests are not allowed; only GET is. A request with -f, -F, --field or --input is a POST unless it says -X GET.`,
        };
  }
  const reads = READS.get(group);
  const verb = verbAfter(words, at);
  if (reads === ANY || (reads !== undefined && (verb === undefined || reads.has(verb))))
    return null;
  const what = reads === undefined ? `gh ${group}` : `gh ${group} ${verb ?? ''}`.trim();
  return {
    deny: `${what} is not allowed in a managed session: 10db opens the pull request when the batch ships, merging stays with the builder, and agents change nothing on GitHub or in gh's config. ${ALLOWED}`,
  };
}
