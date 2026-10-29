import { WorkstreamState, type BatchId } from '@10db/contracts';
import { fillTemplate } from './pr-template';

/** Conventional Commits' longest header, as this repo's commitlint and `config-conventional` set it. */
const MAX_HEADER = 100;

/** A title whose first word is fix, fixes or fixed. */
const FIX_TITLE = /^fix(?:es|ed)?\b/i;

/**
 * The Conventional Commit type and scope a pull request's title opens with: `fix` when every task is a
 * fix, otherwise `feat`, so a feature that carries its own review fixes is still a feature; the scope
 * when there is one.
 */
export function titlePrefix(
  tasks: readonly { readonly title: string }[],
  scope: string | null,
): string {
  const type =
    tasks.length > 0 && tasks.every((task) => FIX_TITLE.test(task.title.trim())) ? 'fix' : 'feat';
  return scope === null ? type : `${type}(${scope})`;
}

/**
 * `<prefix>: <title>` as commitlint wants a header: the title's first letter lowercased, no trailing
 * full stop, and no longer than `MAX_HEADER`, cut at a word. A prefix too long to leave room is the
 * project's own and goes as written.
 */
export function prTitle(prefix: string, title: string): string {
  const trimmed = title.trim().replace(/\.+$/, '').trim() || title.trim();
  const subject = `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
  const room = MAX_HEADER - prefix.length - 2;
  if (subject.length <= room || room < 1) return `${prefix}: ${subject}`;
  const space = subject.lastIndexOf(' ', room);
  const cut = (space > 0 ? subject.slice(0, space) : subject.slice(0, room))
    // A cut between the halves of a surrogate pair drops the stray half.
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/[\s.]+$/, '');
  return `${prefix}: ${cut}`;
}

/** One task of the batch, as the PR body shows it. */
export interface PrBodyTask {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly state: WorkstreamState;
}

/**
 * The PR body, built from records only (batch delivery spec §6). Its sections are the repo's pull
 * request template's when the repo has one; without one they are the two below, in that order.
 */
export function prBody(input: {
  readonly batch: { readonly id: BatchId };
  readonly tasks: readonly PrBodyTask[];
  /** The project's gate command, or null when it has none. */
  readonly gate: { readonly command: string | null };
  /** The CI run for the head that was pushed: its checks page for the commit. */
  readonly ci: { readonly repo: string; readonly sha: string };
  /** The repo's pull request template, or null when it has none. */
  readonly template: string | null;
}): string {
  const body = fillTemplate(input.template, [
    { heading: 'What and why', text: whatAndWhy(input.tasks) },
    { heading: 'How it was checked', text: howChecked(input.gate, input.ci) },
  ]);
  return `${body}\n\n---\n\nShipped by 10db, batch ${input.batch.id}\n`;
}

const word = (state: WorkstreamState): string => state.toLowerCase();

/**
 * Each task's description and criteria go in full: they name the decisions and open items the change
 * rests on, which is the why a reviewer needs.
 */
function whatAndWhy(tasks: readonly PrBodyTask[]): string {
  const blocks = tasks.map((task) => {
    const parts = [`### ${task.title}`];
    if (task.description.trim() !== '') parts.push(task.description.trim());
    if (task.acceptanceCriteria.length > 0)
      parts.push(
        ['Acceptance criteria:', '', ...task.acceptanceCriteria.map((c) => `- ${c}`)].join('\n'),
      );
    return parts.join('\n\n');
  });
  const notDone = tasks.filter((t) => t.state !== WorkstreamState.Done);
  if (notDone.length > 0)
    blocks.push(
      ['Not done:', '', ...notDone.map((t) => `- ${t.title} (${word(t.state)})`)].join('\n'),
    );
  return blocks.join('\n\n');
}

/**
 * Links CI rather than the gate's exit code: the reviewer can open the run, and the gate already
 * passed to reach the push.
 */
function howChecked(
  gate: { readonly command: string | null },
  ci: { readonly repo: string; readonly sha: string },
): string {
  const url = `https://github.com/${ci.repo}/commit/${ci.sha}/checks`;
  const ciLine = `CI run for the pushed head: [${ci.sha.slice(0, 7)}](${url})`;
  if (gate.command === null)
    return ['No gate command: each task was approved in 10db.', '', ciLine].join('\n');
  return [
    'Gate, run on the branch before the push:',
    '',
    '```',
    gate.command,
    '```',
    '',
    ciLine,
  ].join('\n');
}
