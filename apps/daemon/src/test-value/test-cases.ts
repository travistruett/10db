/** A test case found in a test file: a call of `it` or `test`, with the lines of its body. */
export interface TestCase {
  readonly name: string;
  /** The 1-based line the call's name is on. */
  readonly line: number;
  readonly body: string;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEFAULT_BODY_LINES = 40;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** `it('name'`, `test.only(\`name\``: a call with its name on the line. */
const CALL = /^\s*(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
/** The name call of `it.each([...] as const)('name'`, which follows its table. */
const EACH_TAIL = /(?:\]|as const)\)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

function netOpen(line: string): number {
  let net = 0;
  for (const ch of line) {
    if (ch === '(') net += 1;
    else if (ch === ')') net -= 1;
  }
  return net;
}

/** The call's lines: to its closing line at the call's own indent, or to its first line when that closes it. */
function bodyAt(lines: readonly string[], start: number, cap: number): string {
  const first = lines[start] ?? '';
  const taken = [first];
  if (netOpen(first) > 0) {
    const indent = indentOf(first);
    for (let i = start + 1; i < lines.length && taken.length < cap; i += 1) {
      const line = lines[i] ?? '';
      taken.push(line);
      if (indentOf(line) <= indent && /^\s*[})\]]/.test(line)) break;
    }
  }
  return taken.slice(0, cap).join('\n');
}

/** Every test case in `source`, in file order. A table's rows are not cases: the call that runs them is. */
export function testCasesIn(
  source: string,
  options: { readonly bodyLines?: number } = {},
): TestCase[] {
  const cap = options.bodyLines ?? DEFAULT_BODY_LINES;
  const lines = source.split('\n');
  const found: TestCase[] = [];
  lines.forEach((text, index) => {
    const match = CALL.exec(text) ?? EACH_TAIL.exec(text);
    const name = match?.[2];
    if (name === undefined) return;
    found.push({ name, line: index + 1, body: bodyAt(lines, index, cap) });
  });
  return found;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The new-file line numbers a unified diff adds. */
export function addedLines(diff: string): Set<number> {
  const added = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk?.[1] !== undefined) {
      inHunk = true;
      next = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      added.add(next);
      next += 1;
    } else if (line.startsWith(' ')) {
      next += 1;
    }
  }
  return added;
}

/** A multi-file diff cut into one diff per file, keyed by the file's new path, in the diff's order. */
export function splitDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  let path: string | null = null;
  let lines: string[] = [];
  const close = (): void => {
    if (path !== null) files.set(path, lines.join('\n'));
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      close();
      const at = line.lastIndexOf(' b/');
      path = at === -1 ? null : line.slice(at + 3);
      lines = [line];
    } else lines.push(line);
  }
  close();
  return files;
}

/** The cases of `source` whose line a diff added: a new case, not a row added to an existing table. */
export function newTestCases(source: string, diff: string): TestCase[] {
  const added = addedLines(diff);
  return testCasesIn(source).filter((c) => added.has(c.line));
}

/** The value card a commit message carries: its `Value:` line and the lines after it up to a blank one. */
export function valueCardOf(message: string): string | null {
  const lines = message.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('Value:'));
  if (start === -1) return null;
  const card: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === '') break;
    card.push(line.trim());
  }
  return card.join(' ');
}

const RELATIVE_IMPORT = /(?:from|import)\s*(['"])(\.{1,2}\/[^'"]*)\1/g;

/** The relative specifiers a file imports or re-exports from. */
export function localImportsOf(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].flatMap((m) => (m[2] === undefined ? [] : [m[2]]));
}
