import { TASK_MESSAGE_MAX_CHARS, type AreaDef, type TaskId } from '@10db/contracts';
import { classifyPath } from '../guard';

// Workbench spec §8.1, plan §3.1a: where a failed changed-files check goes. Its output is free text,
// so the match is crude on purpose: it names a page only by a whole path that differs from the
// pass's branch and that one page holds; it parses no tool's format. Pure.

/** A task the pass still holds, as the targets read it. */
export interface CheckPage {
  readonly taskId: TaskId;
  /** The areas it holds in the pass (`passHeldAreas`). */
  readonly areas: readonly string[];
  /** Signed off: its page is done, so it is told nothing. */
  readonly signedOff: boolean;
  /** Working on its next turn: it is named only by a path it holds. */
  readonly working: boolean;
}

/** A thread notice: the task, and the paths the output names that it holds (none in a fallback). */
export interface CheckTarget {
  readonly taskId: TaskId;
  readonly paths: readonly string[];
}

/** What can be part of a path; a character outside it ends one. */
const PATH_CHAR = /[A-Za-z0-9_.\-/@+~$]/;

const isPathChar = (char: string | undefined): boolean =>
  char !== undefined && PATH_CHAR.test(char);

/**
 * Whether `output` holds `path` whole: nothing of a path right after it, and before it nothing of a
 * path, `./`, or one of the folder's own absolute paths.
 */
function names(output: string, path: string, roots: readonly string[]): boolean {
  const prefixes = ['', './', ...roots.map((root) => `${root.replace(/\/+$/, '')}/`)];
  for (let at = output.indexOf(path); at !== -1; at = output.indexOf(path, at + 1)) {
    if (isPathChar(output[at + path.length])) continue;
    const before = output.slice(0, at);
    const whole = prefixes.some(
      (prefix) => before.endsWith(prefix) && !isPathChar(before[before.length - prefix.length - 1]),
    );
    if (whole) return true;
  }
  return false;
}

/**
 * The thread notices of a failed check: each changed path the output names whole goes to the one
 * page not signed off whose held areas cover it; with no such page named, every task whose turn ran
 * the check, still held, not signed off and not working on its next turn, gets one naming nothing.
 * `named` is every changed path the output names, for the header.
 */
export function checkTargets(input: {
  /** The end of the check's output. */
  readonly output: string;
  /** The paths that differ from the pass's branch in the folder, repository-relative. */
  readonly changed: readonly string[];
  /** The folder's absolute paths, which may lead a path in the output. */
  readonly roots: readonly string[];
  readonly areas: readonly AreaDef[];
  /** The tasks the pass still holds. */
  readonly pages: readonly CheckPage[];
  /** The tasks whose turns ran the check. */
  readonly ran: readonly TaskId[];
}): { named: string[]; threads: CheckTarget[] } {
  const named = input.changed.filter((path) => names(input.output, path, input.roots));
  const live = input.pages.filter((page) => !page.signedOff);
  const owned = new Map<TaskId, string[]>();
  for (const path of named) {
    const hit = new Set(classifyPath(path, input.areas, []).areas);
    const owners = live.filter((page) => page.areas.some((area) => hit.has(area)));
    const [owner] = owners;
    if (owners.length === 1 && owner)
      owned.set(owner.taskId, [...(owned.get(owner.taskId) ?? []), path]);
  }
  if (owned.size > 0)
    return {
      named,
      threads: live.flatMap((page) => {
        const paths = owned.get(page.taskId);
        return paths ? [{ taskId: page.taskId, paths }] : [];
      }),
    };
  const told = input.ran.filter((taskId) =>
    live.some((page) => page.taskId === taskId && !page.working),
  );
  return { named, threads: [...new Set(told)].map((taskId) => ({ taskId, paths: [] })) };
}

/** The most of a notice's first line, so the output keeps the room. */
const LINE_MAX = 1000;

/** A failed check's first line: the paths it names, or that it names none. */
export function checkNoticeLine(paths: readonly string[]): string {
  const line =
    paths.length === 0
      ? 'Check failed after a turn: it names no changed file'
      : `Check failed: names ${paths.map((path) => `\`${path}\``).join(', ')}`;
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`;
}

/**
 * What Send to Agent sends for a failed check, and the header's text: the line, the command and how
 * it ended, and the end of its output, at most one message long (`TASK_MESSAGE_MAX_CHARS`).
 */
export function checkOffer(input: {
  readonly line: string;
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly output: string;
}): string {
  const ended = input.timedOut ? 'timed out' : `exited ${String(input.exitCode)}`;
  const head = `${input.line}\n\n\`${input.command}\` ${ended}.\n\n\`\`\`\n`;
  const foot = '```';
  // One for the newline the output may need before the fence.
  const room = TASK_MESSAGE_MAX_CHARS - head.length - foot.length - 1;
  const kept = input.output.length <= room ? input.output : `…${input.output.slice(-(room - 1))}`;
  return `${head}${kept}${kept.endsWith('\n') ? '' : '\n'}${foot}`;
}
