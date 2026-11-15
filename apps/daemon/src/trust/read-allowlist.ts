/** What an option's value is: a count, free text, a search pattern or a `git log` format. */
export const OptionValue = {
  Count: 'count',
  Text: 'text',
  Pattern: 'pattern',
  Format: 'format',
} as const;
export type OptionValue = (typeof OptionValue)[keyof typeof OptionValue];

/** What a read command's operands (the words that aren't options) name. */
export const Operands = {
  /** Files whose contents it prints: each must be a regular file the fast path may read. */
  Files: 'files',
  /** Files or folders it lists by name; none means the working directory. */
  Listings: 'listings',
  /** Words it prints or rewrites as text, never opening them. */
  Text: 'text',
  /** git revisions and pathspecs: names, never a `rev:path` blob. */
  Revisions: 'revisions',
} as const;
export type Operands = (typeof Operands)[keyof typeof Operands];

interface ReadRule {
  /** Single letters that take no value and may be bundled (`-la`). */
  readonly letters: string;
  /** Single letters whose value is attached (`-n5`) or the next word (`-n 5`). */
  readonly valued: Readonly<Record<string, OptionValue>>;
  /** Whole option words, matched exactly: null takes no value. */
  readonly words: Readonly<Record<string, OptionValue | null>>;
  /** A long option's value must be attached with `=`, as git reads its revision options. */
  readonly attachedValues: boolean;
  /** `-<n>` is a count (`head -5`, `git log -3`). */
  readonly countShort: boolean;
  readonly operands: Operands;
  /** The first operand is the search pattern unless an option gave one (`-e`). */
  readonly patternFirst: boolean;
  /** At least one operand is needed: with none, the command reads the working directory. */
  readonly needsOperand: boolean;
}

const rule = (parts: Partial<ReadRule> & Pick<ReadRule, 'operands'>): ReadRule => ({
  letters: '',
  valued: {},
  words: {},
  attachedValues: false,
  countShort: false,
  patternFirst: false,
  needsOperand: false,
  ...parts,
});

const { Count, Text, Pattern, Format } = OptionValue;

const HEAD_OR_TAIL = rule({
  letters: 'qv',
  valued: { n: Count, c: Count },
  words: {
    '--lines': Count,
    '--bytes': Count,
    '--quiet': null,
    '--silent': null,
    '--verbose': null,
  },
  countShort: true,
  operands: Operands.Files,
});

const SEARCH_WORDS = {
  '--regexp': Pattern,
  '--ignore-case': null,
  '--line-number': null,
  '--count': null,
  '--files-with-matches': null,
  '--invert-match': null,
  '--word-regexp': null,
  '--fixed-strings': null,
  '--only-matching': null,
  '--max-count': Count,
} as const;
const SEARCH_VALUED = { e: Pattern, m: Count, A: Count, B: Count, C: Count } as const;

/**
 * The read commands 10db's judge lets through with no model, each with the only options it may carry. Anything
 * missing here (an option that recurses, follows links, reads names from a file, prints a patch or runs a program)
 * sends the call to the judge.
 */
const READ_RULES: Readonly<Record<string, ReadRule>> = {
  cat: rule({ letters: 'bensuvtAET', operands: Operands.Files }),
  head: HEAD_OR_TAIL,
  tail: HEAD_OR_TAIL,
  wc: rule({
    letters: 'clmwL',
    words: { '--lines': null, '--words': null, '--bytes': null, '--chars': null },
    operands: Operands.Files,
  }),
  sort: rule({
    letters: 'bdfghiMnrRsuV',
    valued: { k: Text, t: Text },
    words: { '--key': Text, '--field-separator': Text, '--reverse': null, '--numeric-sort': null },
    operands: Operands.Files,
  }),
  grep: rule({
    letters: 'acEFhHiIlLnoqsvwx',
    valued: SEARCH_VALUED,
    words: { ...SEARCH_WORDS, '--extended-regexp': null },
    operands: Operands.Files,
    patternFirst: true,
  }),
  rg: rule({
    letters: 'acFHiIlnNosSvwx',
    valued: SEARCH_VALUED,
    words: { ...SEARCH_WORDS, '--hidden': null },
    operands: Operands.Files,
    patternFirst: true,
    needsOperand: true,
  }),
  diff: rule({
    letters: 'abBiqsuwy',
    valued: { U: Count },
    words: { '--brief': null },
    operands: Operands.Files,
    needsOperand: true,
  }),
  ls: rule({ letters: '1aAdFghilnoprRsStuU', operands: Operands.Listings }),
  stat: rule({ letters: '', operands: Operands.Listings, needsOperand: true }),
  find: rule({
    words: {
      '-name': Text,
      '-iname': Text,
      '-path': Text,
      '-ipath': Text,
      '-type': Text,
      '-maxdepth': Count,
      '-mindepth': Count,
      '-print': null,
      '-print0': null,
      '-empty': null,
      '-o': null,
      '-or': null,
      '-a': null,
      '-and': null,
      '-not': null,
      '!': null,
      '(': null,
      ')': null,
    },
    operands: Operands.Listings,
  }),
  echo: rule({ letters: 'neE', operands: Operands.Text }),
  pwd: rule({ letters: 'LP', operands: Operands.Text }),
  true: rule({ operands: Operands.Text }),
  basename: rule({ letters: 'a', valued: { s: Text }, operands: Operands.Text }),
  dirname: rule({ operands: Operands.Text }),
  'git log': rule({
    valued: { n: Count },
    words: {
      '--oneline': null,
      '--stat': null,
      '--shortstat': null,
      '--name-only': null,
      '--name-status': null,
      '--graph': null,
      '--decorate': null,
      '--no-decorate': null,
      '--abbrev-commit': null,
      '--all': null,
      '--reverse': null,
      '--merges': null,
      '--no-merges': null,
      '--first-parent': null,
      '--follow': null,
      '--max-count': Count,
      '--format': Format,
      '--pretty': Format,
      '--date': Text,
      '--since': Text,
      '--until': Text,
      '--after': Text,
      '--before': Text,
      '--author': Text,
      '--grep': Text,
    },
    attachedValues: true,
    countShort: true,
    operands: Operands.Revisions,
  }),
  'git status': rule({
    letters: 'sb',
    words: { '--short': null, '--branch': null, '--porcelain': null },
    operands: Operands.Revisions,
  }),
  'git rev-parse': rule({
    words: {
      '--show-toplevel': null,
      '--show-prefix': null,
      '--abbrev-ref': null,
      '--symbolic-full-name': null,
      '--short': null,
      '--git-dir': null,
      '--is-inside-work-tree': null,
      '--verify': null,
      '--quiet': null,
    },
    operands: Operands.Revisions,
  }),
  'git ls-files': rule({
    letters: 'cdmo',
    words: {
      '--cached': null,
      '--deleted': null,
      '--modified': null,
      '--others': null,
      '--exclude-standard': null,
    },
    operands: Operands.Revisions,
  }),
  'git describe': rule({
    words: { '--tags': null, '--always': null, '--dirty': null, '--long': null, '--abbrev': Count },
    attachedValues: true,
    operands: Operands.Revisions,
  }),
  'git shortlog': rule({
    letters: 'nse',
    words: {
      '--summary': null,
      '--numbered': null,
      '--email': null,
      '--all': null,
      '--no-merges': null,
    },
    attachedValues: true,
    operands: Operands.Revisions,
  }),
};

/** A word longer than this is never read as an option or operand; the call goes to the judge. */
const MAX_WORD = 4096;

function valueFits(kind: OptionValue, value: string): boolean {
  switch (kind) {
    case OptionValue.Count:
      return /^[+-]?\d{1,9}$/.test(value);
    case OptionValue.Text:
    case OptionValue.Pattern:
      return true;
    case OptionValue.Format:
      // `%G` asks git to check a signature, which runs the gpg program the repository's config names.
      return !value.includes('%G');
  }
}

/** A read command's words, read against its rule: what it reads, and what its operands name. */
export interface ReadCall {
  readonly operands: Operands;
  /** The operands, with a positional search pattern left out. */
  readonly targets: readonly string[];
}

/**
 * Reads one segment (`[command, ...args]`) against the allowlist: its targets when the command is listed and every
 * option is one its rule allows with a value that fits; null otherwise.
 */
export function readCallOf(segment: readonly string[]): ReadCall | null {
  const [cmd = '', ...rest] = segment;
  const isGit = cmd === 'git';
  const key = isGit ? `git ${rest[0] ?? ''}` : cmd;
  if (!Object.hasOwn(READ_RULES, key)) return null;
  const spec = READ_RULES[key];
  if (spec === undefined) return null;
  const args = isGit ? rest.slice(1) : rest;
  const operands: string[] = [];
  let patternGiven = false;
  let endOfOptions = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? '';
    if (word.length > MAX_WORD) return null;
    if (endOfOptions) {
      operands.push(word);
      continue;
    }
    if (word === '--') {
      endOfOptions = true;
      continue;
    }
    const eq = word.indexOf('=');
    const name = word.startsWith('-') && eq > 0 ? word.slice(0, eq) : word;
    if (Object.hasOwn(spec.words, name)) {
      const kind = spec.words[name] ?? null;
      if (kind === null) {
        if (name !== word) return null;
        continue;
      }
      let value: string | undefined;
      if (name !== word) value = word.slice(eq + 1);
      else if (!spec.attachedValues) {
        at += 1;
        value = args[at];
      }
      if (value === undefined || !valueFits(kind, value)) return null;
      if (kind === OptionValue.Pattern) patternGiven = true;
      continue;
    }
    if (word === '-' || !word.startsWith('-')) {
      operands.push(word);
      continue;
    }
    if (spec.countShort && /^-\d{1,9}$/.test(word)) continue;
    if (word.startsWith('--')) return null;
    for (let letterAt = 1; letterAt < word.length; letterAt += 1) {
      const letter = word.charAt(letterAt);
      if (spec.letters.includes(letter)) continue;
      if (!Object.hasOwn(spec.valued, letter)) return null;
      const kind = spec.valued[letter];
      if (kind === undefined) return null;
      const attached = word.slice(letterAt + 1);
      let value: string | undefined = attached;
      if (attached === '') {
        at += 1;
        value = args[at];
      }
      if (value === undefined || !valueFits(kind, value)) return null;
      if (kind === OptionValue.Pattern) patternGiven = true;
      break;
    }
  }
  const targets = spec.patternFirst && !patternGiven ? operands.slice(1) : operands;
  if (spec.patternFirst && !patternGiven && operands.length === 0) return null;
  if (spec.needsOperand && targets.length === 0) return null;
  return { operands: spec.operands, targets };
}
