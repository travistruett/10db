import { describe, expect, it } from 'vitest';
import { withoutStrippedKeys } from './setup-definitions';

describe('withoutStrippedKeys', () => {
  it.each<[string, string, ReturnType<typeof withoutStrippedKeys>]>([
    ['a file with none is left as it is', '---\nname: s\ndescription: hooks in\n---\nBody\n', null],
    [
      'hooks and allowed-tools go, every other key and the body stay',
      '---\nname: s\nhooks: {}\nallowed-tools: Bash\nmodel: opus\n---\nBody !`ls`\n',
      {
        text: '---\nname: s\nmodel: opus\n---\nBody !`ls`\n',
        notes: ['hooks left out', 'pre-approved tools left out'],
      },
    ],
    [
      'a second block the body opens, read once the first is gone',
      '---\nhooks: {}\n---\n---\nhooks:\n  PreToolUse: []\n---\nBody\n',
      { refused: 'what Claude Code would read of it still holds hooks or pre-approved tools' },
    ],
    [
      'a merge key, which another YAML reader may follow',
      '---\nname: s\n<<: {hooks: {}}\n---\nBody\n',
      { refused: "its frontmatter merges in keys 10db can't see" },
    ],
    [
      'unreadable frontmatter whose text could name a stripped key',
      '---\nname: s\n"\\x68ooks": [\n---\nBody\n',
      {
        refused:
          'its frontmatter is not YAML 10db reads, and it may hold hooks or pre-approved tools',
      },
    ],
    ['unreadable frontmatter that could name none', '---\nname: [s\n---\nBody\n', null],
  ])('%s', (_name, text, expected) => {
    expect(withoutStrippedKeys(text)).toEqual(expected);
  });
});
