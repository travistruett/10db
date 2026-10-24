import { WorkstreamState, type BatchId } from '@10db/contracts';
import { fillTemplate } from './pr-template';

/** `<prefix>: <title>` with the title's first letter lowercased: commitlint wants a lowercase subject. */
export function prTitle(prefix: string | null, title: string): string {
  const subject = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return prefix === null ? subject : `${prefix}: ${subject}`;
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
  readonly gate: { readonly command: string };
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
  gate: { readonly command: string },
  ci: { readonly repo: string; readonly sha: string },
): string {
  const url = `https://github.com/${ci.repo}/commit/${ci.sha}/checks`;
  return [
    'Gate, run on the branch before the push:',
    '',
    '```',
    gate.command,
    '```',
    '',
    `CI run for the pushed head: [${ci.sha.slice(0, 7)}](${url})`,
  ].join('\n');
}
