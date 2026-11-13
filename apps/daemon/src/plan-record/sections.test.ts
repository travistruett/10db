import { SectionIndexEntry } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { findSection, indexSections, sectionText } from './sections';

const lines = (...l: string[]): string => l.join('\n');

/** Each row: a body, and the slugs it indexes, in order. */
const ROWS: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'h1 to h4 are sections, h5 is text',
    lines('# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'),
    ['one', 'two', 'three', 'four'],
  ],
  [
    'a heading in a backtick fence is text',
    lines('# Top', '```', '# Decision', '```', '## After'),
    ['top', 'after'],
  ],
  [
    'a heading in a tilde fence is text',
    lines('# Top', '~~~md', '# Decision', '~~~', '## After'),
    ['top', 'after'],
  ],
  [
    'a fence closed by fewer backticks stays open',
    lines('# Top', '````', '```', '# Still code', '````', '## After'),
    ['top', 'after'],
  ],
  [
    'an indented 3-space fence still fences',
    lines('# Top', '   ```sh', '# not a heading', '   ```', '## After'),
    ['top', 'after'],
  ],
  ['#!/bin/sh is text', lines('#!/bin/sh', '# Real'), ['real']],
  ['#123 is text', lines('#123 is an issue', '# Real'), ['real']],
  ['trailing hashes are stripped', lines('## Closing ##', '# Hash#'), ['closing', 'hash']],
  ['Task 12: Pairing slugs to task-12', lines('## Task 12: Pairing'), ['task-12']],
  ['### Task 0: Stop unless M2c slugs to task-0', lines('### Task 0: Stop unless M2c'), ['task-0']],
  [
    'two Overview headings are overview and overview-1',
    lines('# Overview', '# Overview'),
    ['overview', 'overview-1'],
  ],
  [
    'a heading named overview-1 before a second overview pushes it to overview-2',
    lines('# Overview', '# Overview 1', '# Overview'),
    ['overview', 'overview-1', 'overview-2'],
  ],
  [
    'Settings › Sharing is settings--sharing',
    lines('## Settings › Sharing'),
    ['settings--sharing'],
  ],
  [
    'inline code and **(call)** drop their markers',
    lines('## The `fileAt` rule **(call)**', '## _Emphasis_ and snake_case'),
    ['the-fileat-rule-call', 'emphasis-and-snake_case'],
  ],
  ['a body starting with a BOM indexes its first heading', '\uFEFF# One\n## Two', ['one', 'two']],
];

describe('indexSections', () => {
  it.each(ROWS)('%s', (_, body, slugs) => {
    expect(indexSections(body).map((s) => s.slug)).toEqual(slugs);
  });

  it('a section ends at the next heading of its level or higher', () => {
    const body = lines('## A', 'a text', '### A1', 'a1 text', '## B', 'b text');
    const index = indexSections(body);
    const a = findSection(index, 'a');
    const a1 = findSection(index, 'a1');
    expect(a && sectionText(body, a)).toBe(lines('## A', 'a text', '### A1', 'a1 text', ''));
    expect(a1 && sectionText(body, a1)).toBe(lines('### A1', 'a1 text', ''));
    expect(findSection(index, 'b')?.end).toBe(body.length);
  });

  it('an h2 after Task 19 ends before Task 20', () => {
    const body = lines(
      '## Task 19: Last of P1',
      'body 19',
      '## Review Focus',
      'focus',
      '### Task 20: First of P2',
      'body 20',
    );
    const index = indexSections(body);
    const focus = findSection(index, 'review-focus');
    const task20 = findSection(index, 'task-20');
    expect(focus?.end).toBe(task20?.start);
    expect(focus && sectionText(body, focus)).toBe(lines('## Review Focus', 'focus', ''));
  });

  it('a task section nests nothing past the next task', () => {
    const body = lines('## Task 1: One', '#### Step 1', 'do', '### Task 2: Two', 'two');
    const index = indexSections(body);
    const task1 = findSection(index, 'task-1');
    expect(task1 && sectionText(body, task1)).toBe(
      lines('## Task 1: One', '#### Step 1', 'do', ''),
    );
  });

  it('a leading BOM stays in the first section, which starts at 0', () => {
    const body = '\uFEFF# One\nfirst\n# Two\n';
    const index = indexSections(body);
    expect(index.map((s) => [s.slug, s.title, s.start])).toEqual([
      ['one', 'One', 0],
      ['two', 'Two', 13],
    ]);
    const one = findSection(index, 'one');
    expect(one && sectionText(body, one)).toBe('\uFEFF# One\nfirst\n');
  });

  it('a long heading, repeated, still gives slugs its own schema accepts', () => {
    const title = `${'a'.repeat(189)}\u{1D400}${'a'.repeat(60)}`;
    const body = lines(`# ${title}`, `# ${title}`, `## Task ${'9'.repeat(250)}`);
    const index = indexSections(body);
    expect(new Set(index.map((s) => s.slug)).size).toBe(3);
    for (const entry of index) {
      expect(SectionIndexEntry.safeParse(entry).success).toBe(true);
      expect(entry.slug.isWellFormed()).toBe(true);
    }
  });

  it('CRLF bodies keep their \\r in section text', () => {
    const body = '# One\r\nfirst\r\n# Two\r\nsecond\r\n';
    const index = indexSections(body);
    expect(index.map((s) => [s.slug, s.title])).toEqual([
      ['one', 'One'],
      ['two', 'Two'],
    ]);
    const one = findSection(index, 'one');
    expect(one && sectionText(body, one)).toBe('# One\r\nfirst\r\n');
  });

  it('every section is a substring at its offsets', () => {
    for (const [, body] of ROWS) {
      for (const entry of indexSections(body)) {
        const text = sectionText(body, entry);
        expect(body.slice(entry.start, entry.end)).toBe(text);
        expect(text.length).toBeGreaterThan(0);
        expect(entry.end).toBeLessThanOrEqual(body.length);
      }
    }
  });
});
