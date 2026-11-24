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

/** A regular file whose real path stays in the checkout and is not a secret. */
function isCheckoutFile(word: string, cwd: string, ctx: FastPathContext): boolean {
  if (word.startsWith('~') || word.startsWith('-')) return false;
  const path = resolve(cwd, word);
  try {
    if (!statSync(path).isFile()) return false;
    return inside(ctx.checkout, realpathSync(path)) && !namesSecret(path, ctx.secretFiles);
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
 * Whether a Bash call only runs programs that are files of the session's checkout, with operands that name
 * nothing outside it. The kernel sandbox contains such a program (writes stay in the checkout and temp dir,
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
