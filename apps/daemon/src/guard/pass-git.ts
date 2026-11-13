import { commandName, parseShell, stripCommandPrefixes, type ShellSegment } from './shell-words';

/**
 * A commit, a push or a merge a pass may run once the builder allows it on a card, as in Claude Code.
 * 10db runs `argv` itself, outside the sandbox, so it is exactly the words the agent wrote, and every
 * option in it is one that reads nothing outside the checkout. A push names its remote, which must be
 * one the checkout lists when it runs; a push of `HEAD` or `@` pushes the current branch, which is
 * checked then too.
 */
export type PassGitCall =
  | {
      readonly kind: 'run';
      readonly argv: readonly string[];
      readonly push: { readonly remote: string; readonly currentBranch: boolean } | null;
    }
  | { readonly kind: 'refuse'; readonly reason: string };

const VERBS: ReadonlySet<string> = new Set(['commit', 'push', 'merge']);
const PROTECTED_BRANCH = 'main';

/**
 * The options each call may carry: none reads a file, runs a program or reaches past the checkout.
 * `values` take the next word (or the text after `=`); short ones may stand in a cluster, with a
 * value letter last (`-am msg`) or followed by its value (`-mmsg`).
 */
interface Options {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlySet<string>;
  readonly shortFlags: string;
  readonly shortValues: string;
}

const COMMIT: Options = {
  flags: new Set(['--no-edit', '--allow-empty', '--all', '--quiet', '--no-verify']),
  values: new Set(['--message']),
  shortFlags: 'aq',
  shortValues: 'm',
};
const MERGE: Options = {
  flags: new Set(['--no-edit', '--no-ff', '--ff', '--ff-only', '--squash', '--quiet', '--abort']),
  values: new Set(['--message']),
  shortFlags: 'q',
  shortValues: 'm',
};
const PUSH: Options = {
  flags: new Set([
    '--set-upstream',
    '--quiet',
    '--verbose',
    '--dry-run',
    '--no-verify',
    '--follow-tags',
  ]),
  values: new Set(),
  shortFlags: 'uqvn',
  shortValues: '',
};
const GH_MERGE: Options = {
  flags: new Set(['--squash', '--merge', '--rebase', '--auto', '--disable-auto']),
  values: new Set(['--subject', '--body', '--match-head-commit']),
  shortFlags: 'smr',
  shortValues: 'tb',
};

/** What a few common options do, so their refusal reads plainly on the card. */
const WHY_REFUSED: Readonly<Record<string, string>> = {
  '--force': 'it rewrites what the remote holds',
  '--force-with-lease': 'it rewrites what the remote holds',
  '--force-if-includes': 'it rewrites what the remote holds',
  '-f': 'it rewrites what the remote holds',
  '--mirror': 'it rewrites or removes every branch on the remote',
  '--all': 'it pushes every branch, main among them',
  '--delete': 'it removes a branch on the remote',
  '-d': 'it removes a branch on the remote',
  '--prune': 'it removes branches on the remote',
  '--delete-branch':
    'it removes the branch and checks out the default one, and a pass stays on its branch',
  '--amend': 'it rewrites a commit that is already made',
  '--admin': 'it passes over the branch rules',
  '-R': 'it names another repository',
  '--repo': 'it names another repository',
  '-F': 'it reads a file outside the checkout into the call',
  '--file': 'it reads a file outside the checkout into the call',
  '--body-file': 'it reads a file outside the checkout into the call',
};

const refuse = (reason: string): PassGitCall => ({ kind: 'refuse', reason });

const SPELL_IT_OUT =
  'In a pass the builder can allow a commit, a push or a merge as one plain call: `git commit …`, `git push <remote> <branch>`, `git merge <branch>` or `gh pr merge <number>`, alone on its line, with no variable, substitution, redirection or wrapper. Spell it that way and the builder is asked.';

function refuseOption(what: string, option: string): PassGitCall {
  const why = Object.hasOwn(WHY_REFUSED, option) ? WHY_REFUSED[option] : undefined;
  return refuse(
    why === undefined
      ? `${what} ${option} is not offered in a pass: a call 10db runs for the builder carries only options that read nothing outside the checkout.`
      : `${what} ${option} stays refused in a pass: ${why}.`,
  );
}

/**
 * The words after the call's verb that are not options, or a refusal naming the first option the
 * call may not carry. Everything after `--` is a positional word.
 */
function positionalsOf(
  what: string,
  words: readonly string[],
  options: Options,
): string[] | PassGitCall {
  const positional: string[] = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (word === '--') {
      positional.push(...words.slice(at + 1));
      break;
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      if (options.flags.has(name) && eq === -1) continue;
      if (options.values.has(name)) {
        if (eq === -1) at += 1;
        continue;
      }
      return refuseOption(what, name);
    }
    if (word.startsWith('-') && word.length > 1) {
      const letters = word.slice(1);
      for (let i = 0; i < letters.length; i += 1) {
        const letter = letters.charAt(i);
        if (options.shortFlags.includes(letter)) continue;
        if (options.shortValues.includes(letter)) {
          // The rest of the word is the value, else the next word is.
          if (i === letters.length - 1) at += 1;
          break;
        }
        return refuseOption(what, `-${letter}`);
      }
      continue;
    }
    positional.push(word);
  }
  return positional;
}

const isRefusal = (value: string[] | PassGitCall): value is PassGitCall => !Array.isArray(value);

/** A branch name as written: letters, digits and `._/-`, no `..`, never an option or a ref path. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!refs\/)[A-Za-z0-9._/-]+$/;

/** Whether a branch is `main` or the base branch, compared without case as the Mac's refs are. */
export function isProtected(branch: string, defaultBranch: string): boolean {
  const folded = branch.toLowerCase();
  return folded === PROTECTED_BRANCH || folded === defaultBranch.toLowerCase();
}

/** `HEAD` in any case, or `@`: the current branch. */
const isCurrent = (name: string): boolean => name === '@' || name.toLowerCase() === 'head';

/**
 * Where a refspec writes on the remote: what follows its `:`, else the refspec. Only a plain branch
 * name, `refs/heads/<name>`, `HEAD` or `@` is read, from a source that is one too; anything else is
 * null.
 */
function destination(
  refspec: string,
): { readonly current: boolean; readonly branch: string } | null {
  const colon = refspec.indexOf(':');
  if (colon !== refspec.lastIndexOf(':')) return null;
  const dst = colon === -1 ? refspec : refspec.slice(colon + 1);
  const src = colon === -1 ? '' : refspec.slice(0, colon);
  if (src !== '' && !isCurrent(src) && !BRANCH_NAME.test(src)) return null;
  if (isCurrent(dst)) return { current: true, branch: dst };
  const branch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst;
  // git reads `heads/main`, `tags/x` or `remotes/x` as a ref under refs/, so none is a branch name here.
  if (!BRANCH_NAME.test(branch) || /^(heads|tags|remotes|refs)\//i.test(branch)) return null;
  return { current: false, branch };
}

/** A remote named as `git remote` lists one; the checkout's list is read when the call runs. */
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/;

function pushCall(argv: readonly string[], defaultBranch: string): PassGitCall {
  const positional = positionalsOf('git push', argv.slice(2), PUSH);
  if (isRefusal(positional)) return positional;
  const [remote, ...refspecs] = positional;
  if (remote === undefined || refspecs.length === 0)
    return refuse(
      'Name the remote and what to push in a pass: `git push origin <branch>`, or `git push origin HEAD` for the current branch.',
    );
  if (!REMOTE_NAME.test(remote))
    return refuse(
      `git push ${remote} stays refused in a pass: push to a remote the checkout lists, by its name, such as origin.`,
    );
  let current = false;
  for (const refspec of refspecs) {
    if (refspec.startsWith('+') || refspec.startsWith(':'))
      return refuse(
        `git push ${refspec} stays refused in a pass: it forces or removes a branch on the remote.`,
      );
    const dst = destination(refspec);
    if (dst === null)
      return refuse(
        `git push ${refspec} is not offered in a pass: name a branch (\`<branch>\`, \`<branch>:<branch>\`, \`refs/heads/<branch>\`) or HEAD.`,
      );
    if (dst.current) current = true;
    else if (isProtected(dst.branch, defaultBranch))
      return refuse(
        `A push to ${dst.branch} stays refused in a pass: 10db lands the work there when it ships.`,
      );
  }
  return { kind: 'run', argv, push: { remote, currentBranch: current } };
}

function commitCall(argv: readonly string[]): PassGitCall {
  const positional = positionalsOf('git commit', argv.slice(2), COMMIT);
  // Every positional word is a path in the checkout; git refuses one outside it.
  return isRefusal(positional) ? positional : { kind: 'run', argv, push: null };
}

function mergeCall(argv: readonly string[]): PassGitCall {
  const positional = positionalsOf('git merge', argv.slice(2), MERGE);
  if (isRefusal(positional)) return positional;
  const bad = positional.find((word) => !BRANCH_NAME.test(word));
  return bad === undefined
    ? { kind: 'run', argv, push: null }
    : refuse(`git merge ${bad} is not offered in a pass: merge a branch by its name.`);
}

function ghCall(argv: readonly string[]): PassGitCall | null {
  if (argv[1] !== 'pr' || argv[2] !== 'merge') {
    // gh's flags before the group (`gh -R other pr merge`) name another repository.
    return argv.includes('merge') && argv.includes('pr')
      ? refuse(`${SPELL_IT_OUT} gh's flags go after \`gh pr merge\`.`)
      : null;
  }
  const positional = positionalsOf('gh pr merge', argv.slice(3), GH_MERGE);
  if (isRefusal(positional)) return positional;
  // A URL or `owner/repo#n` names a pull request in another repository.
  if (positional.length > 1 || positional.some((word) => !/^[1-9]\d*$/.test(word)))
    return refuse(
      'gh pr merge is offered in a pass only for a pull request of this repository, by its number: `gh pr merge 12`.',
    );
  return { kind: 'run', argv, push: null };
}

/**
 * Whether a segment of the line runs a commit, a push or a merge through git or gh, past wrappers,
 * assignments and a path to the program: then only the plain form is offered, and the rest is
 * refused with how to spell it. A script a segment hands a shell is left to the guard's own rules.
 */
function runsCommitPushOrMerge(segments: readonly ShellSegment[]): boolean {
  return segments.some((segment) => {
    const words = stripCommandPrefixes(segment.words, {
      lookThroughRunners: true,
      skipRedirections: true,
    });
    const program = commandName(words[0] ?? '');
    if (program === 'gh') return words.includes('pr') && words.includes('merge');
    return program === 'git' && words.slice(1).some((word) => VERBS.has(word));
  });
}

/**
 * What a pass does with a Bash command that commits, pushes or merges: a call the builder may allow,
 * a refusal saying why, or null for a command that does none of them (the guard's other rules judge
 * it). `defaultBranch` is the project's base branch; a push to it or to `main` stays refused.
 */
export function passGitCall(command: string, defaultBranch: string): PassGitCall | null {
  const parse = parseShell(command);
  const [segment, ...more] = parse.segments;
  const head = segment?.words[0];
  const plain =
    segment !== undefined &&
    more.length === 0 &&
    parse.certain &&
    segment.wordsCertain &&
    segment.bracesCertain &&
    segment.separator === '' &&
    segment.nested.length === 0 &&
    segment.hereDocuments.length === 0 &&
    !segment.dynamicWords.some(Boolean) &&
    !/[<>|&;]/.test(segment.raw.replaceAll(/'[^']*'|"[^"]*"/g, ''));
  if (!plain || (head !== 'git' && head !== 'gh')) {
    return runsCommitPushOrMerge(parse.segments) ? refuse(SPELL_IT_OUT) : null;
  }
  const argv = segment.words;
  if (head === 'gh') return ghCall(argv);
  const verb = argv[1] ?? '';
  if (verb.startsWith('-'))
    return runsCommitPushOrMerge(parse.segments)
      ? refuse(`${SPELL_IT_OUT} git's own options (-C, -c, --git-dir) are not offered.`)
      : null;
  switch (verb) {
    case 'commit':
      return commitCall(argv);
    case 'push':
      return pushCall(argv, defaultBranch);
    case 'merge':
      return mergeCall(argv);
    default:
      return null;
  }
}
