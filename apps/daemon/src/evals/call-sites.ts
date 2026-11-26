import {
  EvalGapSource,
  MAX_CALL_SITES,
  type EvalCallPattern,
  type EvalCallSiteCountDto,
  type EvalGapDto,
  type HazardDef,
  type StoredEvalManifest,
} from '@10db/contracts';
import type { Git } from '../git';
import { classifyPath } from '../guard';

const CODE = ['**/*.py', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'];
const PYTHON = ['**/*.py'];
const SCRIPT = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'];

/**
 * The model SDKs' own calls, searched only when an assessment recorded no pattern of the project's own: in
 * most projects an SDK call is plumbing under a registry of tasks, which is the unit an eval covers.
 */
export const STOCK_CALL_PATTERNS: readonly EvalCallPattern[] = [
  {
    label: 'Anthropic SDK call',
    regex: String.raw`\.messages\.(create|stream|parse)\(`,
    globs: CODE,
  },
  {
    label: 'OpenAI SDK call',
    regex: String.raw`\.(chat\.completions|responses)\.(create|parse|stream)\(`,
    globs: CODE,
  },
  {
    label: 'AI SDK call',
    regex: String.raw`(^|[^A-Za-z0-9_.])(generateText|streamText|generateObject|streamObject)\(`,
    globs: SCRIPT,
  },
  { label: 'LiteLLM call', regex: String.raw`litellm\.a?completion\(`, globs: PYTHON },
  {
    label: 'Gemini SDK call',
    regex: String.raw`\.(generate_content|generate_content_async|generateContent)\(`,
    globs: CODE,
  },
  {
    label: 'Bedrock call',
    regex: String.raw`\.(invoke_model|converse|converse_stream)\(|(InvokeModel|Converse)Command\(`,
    globs: CODE,
  },
];

/** The patterns a project's call sites are found with: its own once recorded, the stock ones until then. */
export const patternsOf = (manifest: StoredEvalManifest): readonly EvalCallPattern[] =>
  manifest.manifest.callPatterns.length > 0 ? manifest.manifest.callPatterns : STOCK_CALL_PATTERNS;

/** One line a call pattern matched. */
export interface CallSite {
  readonly label: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** What a project's call patterns found at one commit. */
export interface FoundCallSites {
  readonly counts: readonly EvalCallSiteCountDto[];
  readonly sites: readonly CallSite[];
}

/**
 * Every line `patterns` match at `rev`, capped at `MAX_CALL_SITES` across them; null when git answered that
 * it reads nothing there (a partial clone, a commit that is gone). A failed read rejects.
 */
export async function findCallSites(
  git: Pick<Git, 'grepAt'>,
  repoPath: string,
  rev: string,
  patterns: readonly EvalCallPattern[],
): Promise<FoundCallSites | null> {
  const read = await git.grepAt(repoPath, rev, patterns, MAX_CALL_SITES);
  if (read.refused !== null || read.answers.length !== patterns.length) return null;
  const counts: EvalCallSiteCountDto[] = [];
  const sites: CallSite[] = [];
  read.answers.forEach((answer, i) => {
    const label = patterns[i]?.label ?? '';
    counts.push({
      label,
      count: answer.refused ? null : answer.matches.length,
      capped: answer.capped,
    });
    for (const m of answer.matches) sites.push({ label, path: m.path, line: m.line, text: m.text });
  });
  return { counts, sites };
}

/** The path an assessed gap's `where` names, without its `:line`. */
const gapPath = (where: string): string => where.replace(/:\d+(?::\d+)?$/u, '');

/**
 * The sites no suite covers: outside every suite's covered globs (matched as a hazard's globs are), and not
 * in an eval's own definition file or a file an assessed gap already names.
 */
export function uncoveredSites(
  sites: readonly CallSite[],
  manifest: StoredEvalManifest,
  definitions: readonly string[],
): CallSite[] {
  const covered: HazardDef = {
    name: 'covered',
    globs: manifest.manifest.suites.flatMap((s) => s.coveredPaths),
    commands: [],
  };
  const known = new Set([
    ...definitions,
    ...manifest.manifest.suites.flatMap((s) => s.definitionPaths),
    ...manifest.manifest.gaps.map((g) => gapPath(g.where)),
  ]);
  const verdicts = new Map<string, boolean>();
  const isCovered = (path: string): boolean => {
    let held = verdicts.get(path);
    if (held === undefined) {
      held =
        known.has(path) ||
        (covered.globs.length > 0 && classifyPath(path, [], [covered]).hazards.length > 0);
      verdicts.set(path, held);
    }
    return held;
  };
  return sites.filter((s) => !isCovered(s.path));
}

/** A site with no eval as the No Eval list shows it. */
export const siteGap = (site: CallSite): EvalGapDto => ({
  label: site.label,
  where: `${site.path}:${String(site.line)}`.slice(0, 300),
  why: site.text === '' ? 'Found by its call pattern.' : site.text.slice(0, 500),
  source: EvalGapSource.Found,
});
