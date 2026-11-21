import { posix } from 'node:path';
import { JudgeDecision, type TaskId } from '@10db/contracts';
import type { Git } from '../git';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import {
  isTestFile,
  localImportsOf,
  newTestCases,
  splitDiffByFile,
  testCasesIn,
  valueCardOf,
} from './test-cases';
import {
  readTestValue,
  testValueRequest,
  type Neighbour,
  type TestValueCase,
  type TestValueFlag,
} from './test-value-ask';

/** At most this many new tests are judged in one run, in the order the commits added them. */
export const MAX_JUDGED_TESTS = 12;
const MAX_NEIGHBOURS = 20;
const SIBLING_FILES = 6;
const SIBLING_TESTS_EACH = 15;
const NEIGHBOUR_BODY_LINES = 12;
const SIBLING_BODY_LINES = 6;
const DIFF_BYTES = 256 * 1024;
const FILE_BYTES = 256 * 1024;
/** Calls in flight at once for one run. */
const PARALLEL = 4;
const SHORT_SHA = 10;

export interface JudgeNewTestsDeps {
  readonly git: Pick<Git, 'commitMessagesSince' | 'diffSince' | 'fileAt' | 'filesAt'>;
  readonly judge: Judge;
  /** The decision's floor: an answer below it counts as keep. */
  readonly floor: number;
  readonly logger: Pick<Logger, 'warn'>;
}

export interface JudgeNewTestsInput {
  readonly checkout: string;
  /** The commit the work started from: the commits after it are read. */
  readonly base: string;
  readonly head: string;
  /** The work's own commits among them; every commit after `base` when absent. */
  readonly commits?: ReadonlySet<string>;
  readonly taskId: TaskId;
  readonly signal?: AbortSignal;
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx'] as const;

/** The repository paths `specs` name, as imported from `from`; a specifier that names no tracked file is left out. */
function resolveImports(
  from: string,
  specs: readonly string[],
  tree: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  for (const spec of specs) {
    const joined = posix.normalize(posix.join(posix.dirname(from), spec));
    // `./a.js` names `a.ts` in a TypeScript source.
    const bare = joined.replace(/\.(?:m?js)$/, '');
    const hit = [joined, bare]
      .flatMap((base) => EXTENSIONS.map((ext) => `${base}${ext}`))
      .find((candidate) => tree.has(candidate));
    if (hit !== undefined) found.push(hit);
  }
  return found;
}

async function textAt(
  git: JudgeNewTestsDeps['git'],
  checkout: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const read = await git.fileAt(checkout, rev, path, FILE_BYTES);
  return read.kind === 'file' ? read.text : null;
}

/** The tests beside one new test: its file's, nearest first, then those of sibling test files on the same modules. */
async function neighboursOf(
  git: JudgeNewTestsDeps['git'],
  checkout: string,
  rev: string,
  path: string,
  source: string,
  tree: ReadonlySet<string>,
  imports: readonly string[],
): Promise<(line: number) => Neighbour[]> {
  const inFile = testCasesIn(source, { bodyLines: NEIGHBOUR_BODY_LINES });
  const siblings: Neighbour[] = [];
  const dir = posix.dirname(path);
  const sharing = [...tree]
    .filter((p) => p !== path && isTestFile(p) && posix.dirname(p) === dir)
    .sort();
  for (const sibling of sharing) {
    if (siblings.length >= SIBLING_FILES * SIBLING_TESTS_EACH || imports.length === 0) break;
    const text = await textAt(git, checkout, rev, sibling);
    if (text === null) continue;
    const theirs = resolveImports(sibling, localImportsOf(text), tree);
    if (!theirs.some((p) => imports.includes(p))) continue;
    const cases = testCasesIn(text, { bodyLines: SIBLING_BODY_LINES }).slice(0, SIBLING_TESTS_EACH);
    siblings.push(
      ...cases.map((c) => ({ file: sibling, name: c.name, line: c.line, body: c.body })),
    );
    if (new Set(siblings.map((s) => s.file)).size >= SIBLING_FILES) break;
  }
  return (line) => {
    const near = inFile
      .filter((c) => c.line !== line)
      .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))
      .map((c) => ({ file: path, name: c.name, line: c.line, body: c.body }));
    return [...near, ...siblings].slice(0, MAX_NEIGHBOURS);
  };
}

/** Each test a commit made by the work added, with what the judge is shown about it. */
async function collectCases(
  git: JudgeNewTestsDeps['git'],
  input: JudgeNewTestsInput,
): Promise<TestValueCase[]> {
  const cases: TestValueCase[] = [];
  const commits = await git.commitMessagesSince(input.checkout, input.base, input.head);
  for (const commit of commits) {
    // A merge brings in what other work added; it is not this work's tests.
    if (input.commits !== undefined && !input.commits.has(commit.sha)) continue;
    const [parent, ...others] = commit.parents;
    if (parent === undefined || others.length > 0) continue;
    const diff = await git.diffSince(input.checkout, parent, commit.sha, DIFF_BYTES);
    const card = valueCardOf(commit.message);
    let tree: Set<string> | null = null;
    for (const [path, fileDiff] of splitDiffByFile(diff.diff)) {
      if (!isTestFile(path)) continue;
      const source = await textAt(git, input.checkout, commit.sha, path);
      if (source === null) continue;
      const added = newTestCases(source, fileDiff);
      if (added.length === 0) continue;
      tree ??= new Set(await git.filesAt(input.checkout, commit.sha));
      const imports = resolveImports(path, localImportsOf(source), tree);
      const neighbours = await neighboursOf(
        git,
        input.checkout,
        commit.sha,
        path,
        source,
        tree,
        imports,
      );
      for (const test of added) {
        if (cases.length >= MAX_JUDGED_TESTS) return cases;
        cases.push({
          test: {
            file: path,
            name: test.name,
            line: test.line,
            body: test.body,
            commit: commit.sha.slice(0, SHORT_SHA),
            valueCard: card,
          },
          neighbours: neighbours(test.line),
          imports,
        });
      }
    }
  }
  return cases;
}

/**
 * Asks the judge about each test the work's commits added: keep, fold into a neighbour, a duplicate of one, or
 * move cheaper. Returns the answers other than keep that reached the decision's floor. It never throws and
 * never waits on the builder: a decision that is off, a commit git can't read or a judge that fails gives none.
 */
export async function judgeNewTests(
  deps: JudgeNewTestsDeps,
  input: JudgeNewTestsInput,
): Promise<TestValueFlag[]> {
  try {
    if (!(await deps.judge.ready(JudgeDecision.TestValue))) return [];
    const cases = await collectCases(deps.git, input);
    const flags: TestValueFlag[] = [];
    for (let at = 0; at < cases.length; at += PARALLEL) {
      const batch = cases.slice(at, at + PARALLEL);
      const read = await Promise.all(
        batch.map(async (c) => {
          try {
            const answer = await deps.judge.choose(
              testValueRequest(c, {
                taskId: input.taskId,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              }),
            );
            return readTestValue(answer, deps.floor, c);
          } catch (error) {
            deps.logger.warn(
              { taskId: input.taskId, err: error instanceof Error ? error.message : String(error) },
              'the test-value judge could not answer for a test',
            );
            return null;
          }
        }),
      );
      for (const flag of read) if (flag !== null) flags.push(flag);
    }
    return flags;
  } catch (error) {
    deps.logger.warn(
      { taskId: input.taskId, err: error instanceof Error ? error.message : String(error) },
      'the new tests could not be read for the test-value judge',
    );
    return [];
  }
}
