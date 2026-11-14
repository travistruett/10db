import { DEFAULT_HAZARDS, type HazardDef, type KindDto } from '@10db/contracts';
import type { Git } from '../git';
import { classifyPath } from '../guard';

type DiffSince = Awaited<ReturnType<Git['diffSince']>>;

/**
 * Files whose change decides what runs or ships beyond the code a model reads: manifests and lockfiles
 * of the package managers 10db's projects use, CI and workflow files, and the files that configure
 * agents. Beside them a change to any of the project's hazard globs (and the stock ones: migrations,
 * dependencies, the harness) adds a review to light work.
 */
const REVIEW_FORCING_PATHS: HazardDef = {
  name: 'review-forcing',
  globs: [
    '**/package.json',
    '**/pnpm-lock.yaml',
    '**/pnpm-workspace.yaml',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/bun.lock',
    '**/bun.lockb',
    '**/Cargo.toml',
    '**/Cargo.lock',
    '**/go.mod',
    '**/go.sum',
    '**/pyproject.toml',
    '**/poetry.lock',
    '**/uv.lock',
    '**/Gemfile',
    '**/Gemfile.lock',
    '**/drizzle/**',
    '**/migrations/**',
    '.github/**',
    '.claude/**',
    '.codex/**',
    'AGENTS.md',
    '**/AGENTS.md',
    'CLAUDE.md',
    '**/CLAUDE.md',
  ],
  commands: [],
};

/** A change over this many changed lines or files adds a review. */
const FORCED_REVIEW_MAX_LINES = 400;
const FORCED_REVIEW_MAX_FILES = 15;

/** The diff text read with the change: only its per-file counts are used, which are whole whatever the cap. */
export const FORCED_REVIEW_DIFF_BYTES = 1024;

type Changes = Pick<DiffSince, 'files'>;

/**
 * The first reason a review must run on work no review step was planned for, in words, or null when
 * nothing forces one: a kind whose work is always reviewed, a change too large to judge at a glance, a
 * change to a file nobody weighs from a diff (a binary file, a manifest, a lockfile, a migration, CI, an
 * agent-instruction file, a hazard path).
 */
export function forcedReview(
  kinds: readonly Pick<KindDto, 'key' | 'alwaysReviewed'>[],
  changes: Changes,
  projectHazards: readonly HazardDef[],
): string | null {
  const always = kinds.find((kind) => kind.alwaysReviewed);
  if (always) return `an always-reviewed kind (${always.key})`;
  if (changes.files.length > FORCED_REVIEW_MAX_FILES)
    return `${String(changes.files.length)} changed files`;
  const hazards = [...projectHazards, ...DEFAULT_HAZARDS, REVIEW_FORCING_PATHS];
  for (const f of changes.files) {
    if (f.added === null && f.removed === null) return `a binary file (${f.path})`;
    // Matched as areas: a hazard glob read as a hazard lets no `*` or `**` match a dot name, so
    // `**/package.json` would miss `tools/.scripts/package.json`.
    if (classifyPath(f.path, hazards, []).areas.length > 0) return `changes \`${f.path}\``;
  }
  const lines = changes.files.reduce((sum, f) => sum + (f.added ?? 0) + (f.removed ?? 0), 0);
  return lines > FORCED_REVIEW_MAX_LINES ? `${String(lines)} changed lines` : null;
}
