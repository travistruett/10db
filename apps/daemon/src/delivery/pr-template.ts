import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A section of the PR body: its `## heading` and the markdown under it. */
export interface PrSection {
  readonly heading: string;
  readonly text: string;
}

/** Where GitHub reads the repository's pull request template. */
export const PR_TEMPLATE_PATH = '.github/pull_request_template.md';

/**
 * The repository's pull request template, or null when it has none. Shipping reads it from the
 * checkout, which it has checked is on the batch branch.
 */
export function readPrTemplate(repoPath: string): string | null {
  try {
    return readFileSync(join(repoPath, PR_TEMPLATE_PATH), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

/** A level-2 heading only: `###` and deeper are part of the section above them. */
const HEADING = /^##\s+(.*?)\s*$/;

interface TemplateBlock {
  /** Null for the text before the template's first `## ` heading. */
  readonly heading: string | null;
  readonly text: string;
}

function blocksOf(template: string): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  for (const line of template.split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      blocks.push({ heading, text: lines.join('\n').trim() });
      heading = match[1] ?? '';
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  blocks.push({ heading, text: lines.join('\n').trim() });
  return blocks.filter((block) => block.heading !== null || block.text !== '');
}

/** Headings match ignoring case and surrounding spaces. */
const headingKey = (heading: string): string => heading.trim().toLowerCase();

/**
 * The template with each section it names replaced by the matching entry of `sections`, its
 * placeholder comments with it. A template section no entry matches stays as written, and an entry
 * the template has no section for is appended after the template's sections, so no text is lost.
 */
export function fillTemplate(template: string | null, sections: readonly PrSection[]): string {
  const placed = new Set<string>();
  const parts: string[] = [];
  for (const block of blocksOf(template ?? '')) {
    const heading = block.heading;
    const fill =
      heading === null
        ? undefined
        : sections.find((section) => headingKey(section.heading) === headingKey(heading));
    if (fill !== undefined && heading !== null) {
      placed.add(headingKey(heading));
      parts.push(`## ${heading}\n\n${fill.text}`.trimEnd());
    } else {
      parts.push(block.text);
    }
  }
  for (const section of sections) {
    if (!placed.has(headingKey(section.heading)))
      parts.push(`## ${section.heading}\n\n${section.text}`.trimEnd());
  }
  return parts.filter((part) => part !== '').join('\n\n');
}
