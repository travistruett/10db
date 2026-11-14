import type { MentionSerializer } from '@mantine/core';

// Sessions UI spec §7.9: the composer holds `@` files and `/` commands as markup its input keeps beside the
// text, and the message goes out as the text the builder sees with the paths listed. The markup is not
// Mantine's `@[name](id)`: a path may hold `[`, `]` or `)` (`src/[id].tsx`), which that template cannot tell
// from its own delimiters. These brackets are never typed, and never shown: the textarea holds the visible
// text, and the markup is what the input keeps in its value.

const FILE_OPEN = '⦃';
const FILE_CLOSE = '⦄';
const COMMAND_OPEN = '⟦';
const COMMAND_CLOSE = '⟧';

const FILE_MARKUP = /⦃([^⦄]*)⦄/gu;
const COMMAND_MARKUP = /⟦([^⟧]*)⟧/gu;

function serializer(id: string, open: string, close: string, pattern: RegExp): MentionSerializer {
  return {
    id,
    insert: ({ id: name }) => `${open}${String(name)}${close}`,
    findAll: (value) =>
      [...value.matchAll(pattern)].map((match) => ({
        markup: match[0],
        index: match.index,
        id: match[1] ?? '',
        display: match[1] ?? '',
      })),
  };
}

/** How a file the builder picked is kept in the input's value. */
export const FILE_MENTION = serializer('file', FILE_OPEN, FILE_CLOSE, FILE_MARKUP);
/** How a command the builder picked is kept in the input's value. */
export const COMMAND_MENTION = serializer('command', COMMAND_OPEN, COMMAND_CLOSE, COMMAND_MARKUP);

/** What the input's value says as the message goes: `@path` and `/name` text, and the paths listed once. */
export function mentionText(value: string): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  const text = value
    .replace(FILE_MARKUP, (_markup, path: string) => {
      if (!mentions.includes(path)) mentions.push(path);
      return `@${path}`;
    })
    .replace(COMMAND_MARKUP, (_markup, name: string) => `/${name}`);
  return { text, mentions };
}
