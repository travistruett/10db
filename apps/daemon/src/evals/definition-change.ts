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

const BAR = /\b(minimum_rate|min_rate|threshold)\b["']?\s*[=:]\s*(-?\d+(?:\.\d+)?)/;
const GOLDEN_KEY = /\b(expected|expected_output|golden)\b["']?\s*[=:]/;
const GOLDEN_PATH = /(^|\/)golden[^/]*(\/|$)/;
const GRADER_NAME = /(grader|grade|scor)/i;
const GRADER_DEF = /\b(?:def|function|class|const)\s+\w*(?:grader|grade|scor)\w*/i;
const CASE_CALL = /\bCase\(/;
const CASES_FILE = /(^|\/)cases?([^/]*\.(json|jsonl|ya?ml)|\/)/i;
const JUDGE = /\b(llm_judge|judge)\b/i;
const MODEL_ID = /\b(claude|gpt|gemini|o[134])-[\w.-]+/i;

interface PatchLines {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly hunkHeads: readonly string[];
}

function linesOf(patch: string): PatchLines {
  const added: string[] = [];
  const removed: string[] = [];
  const hunkHeads: string[] = [];
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      inHunk = true;
      hunkHeads.push(raw.replace(/^@@[^@]*@@/, '').trim());
    } else if (inHunk && raw.startsWith('+')) added.push(raw.slice(1));
    else if (inHunk && raw.startsWith('-')) removed.push(raw.slice(1));
  }
  return { added, removed, hunkHeads };
}

const shown = (line: string): string => line.trim().slice(0, 160);

/** The first number per bar name on the lines, so an added value can be set against the removed one. */
function barValues(lines: readonly string[]): Map<string, { value: number; line: string }> {
  const out = new Map<string, { value: number; line: string }>();
  for (const line of lines) {
    const found = BAR.exec(line);
    if (found?.[1] === undefined || found[2] === undefined) continue;
    if (!out.has(found[1])) out.set(found[1], { value: Number(found[2]), line });
  }
  return out;
}

/** What each rule finds in the patch; the rules are independent, so one file can be several kinds. */
function rules(path: string, patch: string): EvalDefinitionChange[] {
  const { added, removed, hunkHeads } = linesOf(patch);
  const found: EvalDefinitionChange[] = [];
  const add = (kind: EvalDefinitionChangeKind, line: string): void => {
    found.push({ kind, line: shown(line) });
  };

  const was = barValues(removed);
  for (const [name, now] of barValues(added)) {
    const before = was.get(name);
    if (before !== undefined && now.value < before.value) {
      add(EvalDefinitionChangeKind.BarLowered, now.line);
      break;
    }
  }

  const kept = new Set(added.map((l) => l.trim()));
  const goneCase = removed.find((l) => CASE_CALL.test(l) && !kept.has(l.trim()));
  if (goneCase !== undefined) add(EvalDefinitionChangeKind.CasesRemoved, goneCase);
  else if (CASES_FILE.test(path) && removed.filter((l) => l.trim() !== '').length > added.length) {
    const first = removed.find((l) => l.trim() !== '' && !kept.has(l.trim()));
    if (first !== undefined) add(EvalDefinitionChangeKind.CasesRemoved, first);
  }

  const goldenLine = [...removed, ...added].find((l) => GOLDEN_KEY.test(l));
  if (goldenLine !== undefined) add(EvalDefinitionChangeKind.GoldenChanged, goldenLine);
  else if (GOLDEN_PATH.test(path)) add(EvalDefinitionChangeKind.GoldenChanged, path);

  const graderLine = [...removed, ...added].find((l) => GRADER_DEF.test(l));
  const graderHead = hunkHeads.find((h) => GRADER_DEF.test(h));
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (graderLine !== undefined) add(EvalDefinitionChangeKind.GraderChanged, graderLine);
  else if (graderHead !== undefined) add(EvalDefinitionChangeKind.GraderChanged, graderHead);
  else if (GRADER_NAME.test(base)) add(EvalDefinitionChangeKind.GraderChanged, path);

  const judge = added.find(
    (l) => JUDGE.test(l) || (MODEL_ID.test(l) && /(grad|judg|scor)/i.test(l)),
  );
  if (judge !== undefined) add(EvalDefinitionChangeKind.ModelJudgeAdded, judge);

  return found;
}

/** Each kind the patch of one definition file shows, with the line that showed it; `unclassified` when none. */
export function classifyDefinitionChange(path: string, patch: string): EvalDefinitionChange[] {
  const found = rules(path, patch);
  return found.length > 0 ? found : [{ kind: EvalDefinitionChangeKind.Unclassified, line: '' }];
}

/** A classification as a hit keeps it: the changes and the text a builder reads, naming each line. */
export function definitionHit(
  suiteKey: string,
  changes: readonly EvalDefinitionChange[],
): EvalDefinitionHit {
  const reason = changes
    .map((c) => (c.line === '' ? KIND_WORDS[c.kind] : `${KIND_WORDS[c.kind]} (\`${c.line}\`)`))
    .join('; ');
  return { suiteKey, changes: [...changes], reason };
}
