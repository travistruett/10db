import { SECTION_MAX_LEVEL, type SectionIndexEntry } from '@10db/contracts';

// A document's sections, from its ATX headings, so `doc#slug` names the same text every time. Only
// headings of levels 1 to SECTION_MAX_LEVEL outside a fence start a section; setext headings are text.

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TASK_TITLE = /^Task (\d+)(?=[:. ]|$)/;

interface Heading {
  level: number;
  title: string;
  start: number;
  isTask: boolean;
  base: string;
}

/** A heading's text without its closing `#`s. */
function headingTitle(rest: string): string {
  return rest
    .trim()
    .replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
    .trim();
}

/**
 * The text GitHub reads a heading's slug from: links by their text, inline code and emphasis without
 * their markers. Underscores inside a word, as in snake_case, stay.
 */
function plainText(title: string): string {
  return title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`+[^`]*`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part.replace(/`/g, '')
        : part
            .replace(/\*+/g, '')
            .replace(/(^|[\s\p{P}])_+(?=\S)/gu, '$1')
            .replace(/(?<=\S)_+(?=$|[\s\p{P}])/gu, ''),
    )
    .join('');
}

/** GitHub's slug: lower case, letters, numbers, marks, `-` and `_` kept, each space a `-`. */
function slugOf(title: string): string {
  const slug = plainText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
  return slug === '' ? 'section' : slug;
}

/** The headings of a body, in order, with fenced lines skipped. */
function headingsOf(body: string): Heading[] {
  const headings: Heading[] = [];
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const raw of body.split('\n')) {
    const start = offset;
    offset += raw.length + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence !== null) {
      const close = new RegExp(
        `^ {0,3}${fence.char === '`' ? '`' : '~'}{${String(fence.length)},}[ \\t]*$`,
      );
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const marker = open?.[1];
    if (marker !== undefined && !(marker.startsWith('`') && (open?.[2] ?? '').includes('`'))) {
      fence = { char: marker.charAt(0), length: marker.length };
      continue;
    }
    const atx = ATX.exec(line);
    const hashes = atx?.[1];
    if (hashes === undefined || hashes.length > SECTION_MAX_LEVEL) continue;
    const title = headingTitle(atx?.[2] ?? '');
    const task = TASK_TITLE.exec(title);
    headings.push({
      level: hashes.length,
      title,
      start,
      isTask: task !== null,
      base: task === null ? slugOf(title) : `task-${task[1] ?? ''}`,
    });
  }
  return headings;
}

/**
 * The sections of a body. A section runs from its heading to the next heading of the same or a higher
 * level, or to the next `Task <n>` heading, so a shared section between two tasks never carries the
 * next task. A repeated slug gets `-1`, `-2`, skipping any another heading already took.
 */
export function indexSections(body: string): SectionIndexEntry[] {
  const headings = headingsOf(body);
  const taken = new Set<string>();
  return headings.map((heading, i) => {
    let slug = heading.base;
    for (let n = 1; taken.has(slug); n += 1) slug = `${heading.base}-${String(n)}`;
    taken.add(slug);
    const next = headings
      .slice(i + 1)
      .find((later) => later.level <= heading.level || later.isTask);
    return {
      slug,
      level: heading.level,
      title: heading.title,
      start: heading.start,
      end: next?.start ?? body.length,
    };
  });
}

/** A section's text, byte for byte as the body holds it. */
export function sectionText(body: string, entry: SectionIndexEntry): string {
  return body.slice(entry.start, entry.end);
}

export function findSection(
  index: readonly SectionIndexEntry[],
  slug: string,
): SectionIndexEntry | undefined {
  return index.find((entry) => entry.slug === slug);
}
