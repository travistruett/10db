import {
  EvalDefinitionChangeKind,
  type EvalDefinitionChange,
  type EvalDefinitionHit,
} from '@10db/contracts';

// What a run's change to one eval definition file did, read from the lines of its unified patch. The rules are
// patterns in code, so the answer is the same on every provider and no model is called. A change no rule reads is
// `unclassified`, which still shows: a miss never hides a change.

const KIND_WORDS: Readonly<Record<EvalDefinitionChangeKind, string>> = {
  [EvalDefinitionChangeKind.BarLowered]: 'bar lowered',
  [EvalDefinitionChangeKind.CasesRemoved]: 'cases removed',
  [EvalDefinitionChangeKind.GoldenChanged]: 'golden changed',
  [EvalDefinitionChangeKind.GraderChanged]: 'grader changed',
  [EvalDefinitionChangeKind.ModelJudgeAdded]: 'model judge added',
  [EvalDefinitionChangeKind.Unclassified]: 'definition changed, unclassified',
};

/**
 * A bar's name: bounded on each side, since a lane writes these lines and an unbounded `\w*?` before the
 * alternation backtracks over every start in a long identifier.
 */
const BAR_NAME = String.raw`\w{0,40}?(?:minimum_rate|min_rate|threshold)\w{0,40}`;
/** Past this a line is not read for bars: no gate table writes one, and it bounds the regex's work. */
const MAX_BAR_LINE = 500;
const BAR_VALUE = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)`;
/** A bar's name (with an optional type annotation) and number, read everywhere on a line. */
const barPattern = (): RegExp =>
  new RegExp(
    String.raw`(?<![A-Za-z0-9])(${BAR_NAME})["']?(?:\s*:\s*[\w.\[\]]+)?\s*[=:]\s*(${BAR_VALUE})`,
    'gi',
  );
const GOLDEN_KEY = /\b(expected|expected_output|golden)\b["']?\s*[=:](?![=])/;
const GOLDEN_PATH = /(^|\/)golden[^/]*(\/|$)/;
const GRADER_FILE = /(^|[^a-z])(graders?|grading|grade|scorers?|scoring|scores?)([^a-z]|$)/i;
const GRADER_DEF =
  /\b(?:def|function|class|const|let)\s+(?:\w+_)?(?:graders?|grading|grade|scorers?|scoring|scores?)(?![a-z])\w*/i;
const DECLARATION = /^\s*(?:async\s+)?(?:def|function|class)\b/;
const CASE_CALL = /\bCase\(/;
const CASES_FILE = /(^|\/)cases?([^/]*\.(json|jsonl|ya?ml)|\/)/i;
const JUDGE = /\b(llm_judge|judge)\b/i;
const MODEL_ID = /\b(claude|gpt|gemini|o[134])-[\w.-]+/i;
const COMMENT = /^\s*(#|\/\/|\*|--|\/\*)/;

interface Hunk {
  readonly head: string;
  readonly added: string[];
  readonly removed: string[];
}

/** The hunks of a patch; a later file's header (`diff --git`) ends the hunk, so its ---/+++ lines are never read. */
function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git')) current = null;
    else if (raw.startsWith('@@')) {
      current = { head: raw.replace(/^@@[^@]*@@/, '').trim(), added: [], removed: [] };
      hunks.push(current);
    } else if (current !== null && raw.startsWith('+')) current.added.push(raw.slice(1));
    else if (current !== null && raw.startsWith('-')) current.removed.push(raw.slice(1));
  }
  return hunks;
}

const shown = (line: string): string => line.trim().slice(0, 160);
const trimmed = (lines: readonly string[]): Set<string> => new Set(lines.map((l) => l.trim()));
/** The lines of `lines` that the other side doesn't have: a moved or reformatted-in-place line is not a change. */
const only = (lines: readonly string[], other: ReadonlySet<string>): string[] =>
  lines.filter((l) => l.trim() !== '' && !other.has(l.trim()));

interface Bar {
  readonly name: string;
  readonly value: number;
}

function barsOf(line: string): Bar[] {
  if (line.length > MAX_BAR_LINE) return [];
  return [...line.matchAll(barPattern())].flatMap((m) =>
    m[1] === undefined || m[2] === undefined
      ? []
      : [{ name: m[1].toLowerCase(), value: Number(m[2]) }],
  );
}

const masked = (line: string): string =>
  line.length > MAX_BAR_LINE ? line : line.replace(barPattern(), '$1=#');

/**
 * A line that lowered a bar: each removed bar line is paired with an added one (the same text with its numbers
 * masked, else the next in order), and a pair whose number went down counts. A bar line deleted with nothing in its
 * place counts too. A pair that another reverses (lowered, then restored) is no change.
 */
function loweredBar(hunks: readonly Hunk[]): string | undefined {
  const pairs: { removed: string; added: string | null }[] = [];
  for (const hunk of hunks) {
    const addedSide = trimmed(hunk.added);
    const removedSide = trimmed(hunk.removed);
    const gone = only(hunk.removed, addedSide).filter((l) => barsOf(l).length > 0);
    const came = only(hunk.added, removedSide).filter((l) => barsOf(l).length > 0);
    const used = new Set<number>();
    for (const removed of gone) {
      let at = came.findIndex((a, i) => !used.has(i) && masked(a) === masked(removed));
      if (at < 0) at = came.findIndex((_, i) => !used.has(i));
      if (at >= 0) used.add(at);
      pairs.push({ removed, added: at >= 0 ? (came[at] ?? null) : null });
    }
  }
  for (const pair of pairs) {
    if (pair.added === null) return pair.removed;
    const reversed = pairs.some(
      (p) => p.removed.trim() === pair.added?.trim() && p.added?.trim() === pair.removed.trim(),
    );
    if (reversed) continue;
    const before = barsOf(pair.removed);
    const lowered = barsOf(pair.added).some((b, i) => {
      const was = before[i] ?? before.find((x) => x.name === b.name);
      return was !== undefined && b.value < was.value;
    });
    if (lowered) return pair.added;
  }
  return undefined;
}

/** How many cases a cases file's lines hold: entries by the file's own syntax, so a reformat counts the same. */
function caseCount(path: string, lines: readonly string[]): number {
  if (/\.jsonl$/i.test(path)) return lines.filter((l) => l.trim() !== '').length;
  if (/\.json$/i.test(path)) return lines.reduce((n, l) => n + l.split('{').length - 1, 0);
  return lines.filter((l) => /^\s*-\s/.test(l)).length;
}

/** What each rule finds in the patch; the rules are independent, so one file can be several kinds. */
function rules(path: string, patch: string): EvalDefinitionChange[] {
  const hunks = hunksOf(patch);
  const added = hunks.flatMap((h) => h.added);
  const removed = hunks.flatMap((h) => h.removed);
  const addedSide = trimmed(added);
  const removedSide = trimmed(removed);
  const found: EvalDefinitionChange[] = [];
  const add = (kind: EvalDefinitionChangeKind, line: string): void => {
    found.push({ kind, line: shown(line) });
  };

  const lowered = loweredBar(hunks);
  if (lowered !== undefined) add(EvalDefinitionChangeKind.BarLowered, lowered);

  const casesRemoved = removed.filter((l) => CASE_CALL.test(l));
  const casesAdded = added.filter((l) => CASE_CALL.test(l));
  if (casesRemoved.length > casesAdded.length) {
    add(
      EvalDefinitionChangeKind.CasesRemoved,
      only(casesRemoved, addedSide)[0] ?? casesRemoved[0] ?? '',
    );
  } else if (CASES_FILE.test(path) && caseCount(path, removed) > caseCount(path, added)) {
    add(EvalDefinitionChangeKind.CasesRemoved, only(removed, addedSide)[0] ?? path);
  }

  const isValue = (l: string): boolean => GOLDEN_KEY.test(l) && !DECLARATION.test(l);
  const goldenGone = only(removed, addedSide).filter(isValue);
  const goldenCame = only(added, removedSide).filter(isValue);
  if (goldenGone.length > 0 && goldenCame.length > 0) {
    add(EvalDefinitionChangeKind.GoldenChanged, goldenCame[0] ?? '');
  } else if (GOLDEN_PATH.test(path)) add(EvalDefinitionChangeKind.GoldenChanged, path);

  const changedLines = [...only(removed, addedSide), ...only(added, removedSide)];
  const graderLine = changedLines.find((l) => GRADER_DEF.test(l));
  const graderHead = hunks.find((h) => GRADER_DEF.test(h.head));
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (graderLine !== undefined) add(EvalDefinitionChangeKind.GraderChanged, graderLine);
  else if (graderHead !== undefined) add(EvalDefinitionChangeKind.GraderChanged, graderHead.head);
  else if (GRADER_FILE.test(base)) add(EvalDefinitionChangeKind.GraderChanged, path);

  // An edit of a judge line, or a move of one, adds no judge: more of them must be in the added lines than the removed.
  const isJudge = (l: string): boolean =>
    !COMMENT.test(l) && (JUDGE.test(l) || (MODEL_ID.test(l) && /(grad|judg|scor)/i.test(l)));
  const judge =
    added.filter(isJudge).length > removed.filter(isJudge).length
      ? only(added, removedSide).find(isJudge)
      : undefined;
  if (judge !== undefined) add(EvalDefinitionChangeKind.ModelJudgeAdded, judge);

  return found;
}

/** Each kind the patch of one definition file shows, with the line that showed it; `unclassified` when none. */
export function classifyDefinitionChange(path: string, patch: string): EvalDefinitionChange[] {
  const found = rules(path, patch);
  return found.length > 0 ? found : [{ kind: EvalDefinitionChangeKind.Unclassified, line: '' }];
}

/**
 * The classification as text. `code` quotes each line in backticks for markdown; `unread` is a patch that was cut
 * before it could be read in full, which an unclassified result must say rather than claim to have read.
 */
export function definitionReason(
  changes: readonly EvalDefinitionChange[],
  code: boolean,
  unread = false,
): string {
  return changes
    .map((c) => {
      if (c.line === '') {
        return c.kind === EvalDefinitionChangeKind.Unclassified && unread
          ? 'definition changed, not read in full'
          : KIND_WORDS[c.kind];
      }
      const line = code ? `\`${c.line.replaceAll('`', "'")}\`` : c.line;
      return `${KIND_WORDS[c.kind]} (${line})`;
    })
    .join('; ');
}

/** A classification as a hit keeps it: the changes and the text the drawer shows, naming each line. */
export function definitionHit(
  suiteKey: string,
  changes: readonly EvalDefinitionChange[],
  unread = false,
): EvalDefinitionHit {
  return { suiteKey, changes: [...changes], reason: definitionReason(changes, false, unread) };
}
