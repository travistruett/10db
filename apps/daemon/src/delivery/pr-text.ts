import { WorkstreamState, type BatchId } from '@10db/contracts';

/** `<prefix>: <title>` with the title's first letter lowercased: commitlint wants a lowercase subject. */
export function prTitle(prefix: string | null, title: string): string {
  const subject = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return prefix === null ? subject : `${prefix}: ${subject}`;
}

/** The PR body, built from records only (batch delivery spec §6). */
export function prBody(input: {
  readonly batch: { readonly id: BatchId; readonly title: string };
  readonly rows: readonly { readonly title: string; readonly state: WorkstreamState }[];
  readonly gate: { readonly command: string; readonly exitCode: number };
}): string {
  const word = (state: WorkstreamState): string => state.toLowerCase();
  const notDone = input.rows.filter((r) => r.state !== WorkstreamState.Done);
  const lines = [
    `## ${input.batch.title}`,
    '',
    '### Tasks',
    '',
    ...input.rows.map((r) => `- ${r.title}: ${word(r.state)}`),
    '',
    '### Gate',
    '',
    '```',
    input.gate.command,
    '```',
    '',
    `Exited ${String(input.gate.exitCode)} on the branch as pushed.`,
    ...(notDone.length > 0
      ? ['', '### Not done', '', ...notDone.map((r) => `- ${r.title} (${word(r.state)})`)]
      : []),
    '',
    '---',
    '',
    `Shipped by 10db, batch ${input.batch.id}`,
  ];
  return `${lines.join('\n')}\n`;
}
