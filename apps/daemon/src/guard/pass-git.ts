import { commandName, parseShell, stripCommandPrefixes, type ShellSegment } from './shell-words';

/**
 * A commit, a push or a merge a pass may run once the builder allows it on a card, as in Claude Code.
 * 10db runs `argv` itself, outside the sandbox, so it is exactly the words the agent wrote. A push of
 * `HEAD` pushes the current branch, which is checked when it runs.
 */
export type PassGitCall =
  | {
      readonly kind: 'run';
      readonly argv: readonly string[];
      readonly pushesCurrentBranch: boolean;
    }
  | { readonly kind: 'refuse'; readonly reason: string };

const VERBS: ReadonlySet<string> = new Set(['commit', 'push', 'merge']);
/** Push options that rewrite or remove what the remote holds, or run a program there. */
const PUSH_REFUSED = [
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--all',
  '--delete',
  '--prune',
  '--receive-pack',
  '--exec',
  '--repo',
];
/** Push options whose value is the next word. */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-o', '--push-option']);
const PROTECTED_BRANCH = 'main';

const refuse = (reason: string): PassGitCall => ({ kind: 'refuse', reason });

const SPELL_IT_OUT =
  'In a pass the builder can allow a commit, a push or a merge as one plain call: `git commit …`, `git push …`, `git merge …` or `gh pr merge …`, alone on its line, with no variable, substitution, redirection or wrapper. Spell it that way and the builder is asked.';

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

/** Whether a branch is `main` or the base branch, compared without case as the Mac's refs are. */
export function isProtected(branch: string, defaultBranch: string): boolean {
  const folded = branch.toLowerCase();
  return folded === PROTECTED_BRANCH || folded === defaultBranch.toLowerCase();
}

/** The branch a refspec writes on the remote: what follows its last `:`, without `refs/heads/`. */
function destination(refspec: string): string {
  const dst = refspec.includes(':') ? refspec.slice(refspec.lastIndexOf(':') + 1) : refspec;
  return dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst;
}

function pushCall(argv: readonly string[], defaultBranch: string): PassGitCall {
  const positional: string[] = [];
  for (let at = 2; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (PUSH_VALUE_OPTIONS.has(word)) {
      at += 1;
      continue;
    }
    if (word.startsWith('--')) {
      const name = word.split('=')[0] ?? word;
      if (PUSH_REFUSED.some((option) => option.startsWith(name) && name.length > 2))
        return refuse(
          `git push ${name} stays refused in a pass: it rewrites or removes what the remote holds.`,
        );
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      if (/[fd]/.test(word.slice(1)))
        return refuse(
          `git push ${word} stays refused in a pass: it forces or deletes on the remote.`,
        );
      continue;
    }
    positional.push(word);
  }
  const [remote, ...refspecs] = positional;
  // A remote by its configured name: a URL or a path would send the work somewhere the project never named.
  if (remote !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(remote))
    return refuse(
      `git push ${remote} stays refused in a pass: push to a remote by its name, such as origin.`,
    );
  // With no branch named, git's push.default decides what goes, and `matching` would send main too.
  if (refspecs.length === 0)
    return refuse(
      'Name what to push in a pass: `git push origin <branch>`, or `git push origin HEAD` for the current branch.',
    );
  for (const refspec of refspecs) {
    if (refspec.startsWith('+') || refspec.startsWith(':'))
      return refuse(
        `git push ${refspec} stays refused in a pass: it forces or deletes a branch on the remote.`,
      );
    const dst = destination(refspec);
    if (isProtected(dst, defaultBranch))
      return refuse(
        `A push to ${dst} stays refused in a pass: 10db lands the work there when it ships.`,
      );
  }
  const current = refspecs.some((refspec) => destination(refspec) === 'HEAD');
  return { kind: 'run', argv, pushesCurrentBranch: current };
}

function ghCall(argv: readonly string[]): PassGitCall | null {
  if (argv[1] !== 'pr' || argv[2] !== 'merge') {
    // gh's flags before the group (`gh -R other pr merge`) name another repository.
    return argv.includes('merge') && argv.includes('pr')
      ? refuse(`${SPELL_IT_OUT} gh's flags go after \`gh pr merge\`.`)
      : null;
  }
  for (const word of argv.slice(3)) {
    const name = word.split('=')[0] ?? word;
    if (name === '--admin')
      return refuse(
        'gh pr merge --admin stays refused in a pass: it passes over the branch rules.',
      );
    if (name.startsWith('-R') || name === '--repo')
      return refuse('gh pr merge in another repository stays refused in a pass.');
  }
  return { kind: 'run', argv, pushesCurrentBranch: false };
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
  if (!VERBS.has(verb)) return null;
  return verb === 'push'
    ? pushCall(argv, defaultBranch)
    : { kind: 'run', argv, pushesCurrentBranch: false };
}
