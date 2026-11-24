import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { plainCommandWords } from '../guard';
import { namesSecret, type FastPathContext, type LimitCall } from './fast-path';

/** Interpreters that run a script named by their first operand. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['sh', 'bash', 'python', 'python3', 'node']);

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const GIT_CHECK_MS = 5_000;

const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/** Whether git tracks `path` and neither the index nor the working tree differs from `start` at it. */
function isCommittedUnmodified(checkout: string, path: string, start: string | null): boolean {
  if (start === null || !COMMIT_ID.test(start)) return false;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const git = (args: readonly string[]): boolean => {
    try {
      execFileSync('git', ['-C', checkout, ...args, '--', path], {
        env,
        timeout: GIT_CHECK_MS,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  return git(['ls-files', '--error-unmatch']) && git(['diff', '--quiet', start]);
}

/**
 * A regular file that git tracks and has not changed since the commit the session started from, whose real path stays in the checkout and is
 * not a secret. A script the session wrote or edited is never one: the sandbox does not contain everything a
 * script can do (a container the project's Docker access reaches), so only code the builder committed is
 * exempt from the judge's floor.
 */
function isCheckoutFile(word: string, cwd: string, ctx: FastPathContext): boolean {
  if (word.startsWith('~') || word.startsWith('-')) return false;
  const path = resolve(cwd, word);
  try {
    if (!statSync(path).isFile()) return false;
    const real = realpathSync(path);
    return (
      inside(realpathSync(ctx.checkout), real) &&
      !namesSecret(path, ctx.secretFiles) &&
      isCommittedUnmodified(realpathSync(ctx.checkout), real, ctx.startCommit)
    );
  } catch {
    return false;
  }
}

/** An operand that names no place outside the checkout: it is plain text, or a path in it or the temp dir. */
function isHarmlessOperand(word: string, cwd: string, ctx: FastPathContext): boolean {
  if (word.startsWith('~') || word.includes('..')) return false;
  if (!word.includes('/') && !word.startsWith('.')) return true;
  const path = word.startsWith('-') ? null : resolve(cwd, word);
  if (path === null) return true;
  return (
    (inside(ctx.checkout, path) || inside(ctx.tmpDir, path)) && !namesSecret(path, ctx.secretFiles)
  );
}

function segmentRunsCheckoutProgram(
  words: readonly string[],
  cwd: string,
  ctx: FastPathContext,
): boolean {
  const [first, second, ...rest] = words;
  if (first === undefined) return false;
  let program = first;
  let operands: readonly string[] = [second, ...rest].filter((w): w is string => w !== undefined);
  if (SCRIPT_RUNNERS.has(first)) {
    if (second === undefined) return false;
    program = second;
    operands = rest;
  } else if (!first.includes('/')) {
    return false;
  }
  return (
    isCheckoutFile(program, cwd, ctx) && operands.every((word) => isHarmlessOperand(word, cwd, ctx))
  );
}

/**
 * Whether a Bash call only runs programs that are committed, unmodified files of the session's checkout, with
 * operands that name nothing outside it. The kernel sandbox contains such a program (writes stay in the checkout and temp dir,
 * credentials are closed, the network is the project's allowed hosts), so a judge unsure of a script it cannot
 * read is no reason to stop it: it is the repo's own code, which the repo's instructions tell agents to run.
 */
export function runsCheckoutProgram(call: LimitCall, ctx: FastPathContext): boolean {
  if (call.toolName !== 'Bash' || typeof call.input !== 'object' || call.input === null)
    return false;
  const command = (call.input as Record<string, unknown>)['command'];
  if (typeof command !== 'string') return false;
  const segments = plainCommandWords(command);
  return (
    segments !== null &&
    segments.length > 0 &&
    segments.every((words) => segmentRunsCheckoutProgram(words, call.cwd, ctx))
  );
}
