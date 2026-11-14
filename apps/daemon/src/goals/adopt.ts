import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { GoalAdoptInput, GoalAdoptIssue, ProjectId } from '@10db/contracts';
import { getProject, insertGoal, listPeople, type DbReader } from '@10db/db';
import type { GoalAdoptResult } from '../api';
import type { StateStore } from '../events';
import { proposePlacement } from '../placement';
import { checkBriefRules, parseBrief } from './brief';

// Goals spec §11 and decisions/2026-11-01-adopt-a-goal-from-a-brief.md: the brief is imported, not
// kept in the repository. Its title, objective, notes, criteria and tasks live in 10db with the goal.

/** A brief is a few kilobytes of Markdown; a file past this is not one. */
const MAX_BRIEF_BYTES = 1024 * 1024;

/**
 * Reads, checks and (unless `dryRun`) writes the brief. Every refusal comes back as a list of
 * errors with where each is; nothing is written for a refusal or a dry run. The database write
 * is one transaction, so a brief that slips past the checks still leaves nothing behind.
 */
export async function adoptGoal(
  deps: { readonly state: StateStore },
  projectId: ProjectId,
  input: GoalAdoptInput,
): Promise<GoalAdoptResult> {
  const db: DbReader = deps.state.db;
  // An unknown project is a 404, before the brief is read.
  const project = getProject(db, projectId);

  const read = await briefText(input);
  if (!read.ok) return { kind: 'refused', errors: read.errors };

  const parsed = parseBrief(read.text);
  if (!parsed.ok) return { kind: 'refused', errors: parsed.errors };

  const errors = checkBriefRules(parsed.brief, {
    areaNames: project.areas.map((a) => a.name),
    people: listPeople(db),
  });
  if (errors.length > 0) return { kind: 'refused', errors };

  if (input.dryRun) {
    return {
      kind: 'previewed',
      preview: {
        dryRun: true,
        title: parsed.brief.title,
        taskKeys: parsed.brief.tasks.map((t) => t.key),
        criteria: parsed.brief.criteria.length,
      },
    };
  }
  const { goal } = deps.state.write((ctx) =>
    insertGoal(ctx, projectId, {
      brief: parsed.brief,
      description: parsed.notes,
      // Task placement spec P2: the rule runs when a task is made, and adoption makes tasks.
      placeTask: (areas) => proposePlacement(project, { areas, kinds: [] }),
    }),
  );
  return { kind: 'adopted', goal };
}

type BriefText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly errors: GoalAdoptIssue[] };

async function briefText(input: GoalAdoptInput): Promise<BriefText> {
  if (input.text !== undefined) {
    // The same limit as a file, counted in bytes: a string of N characters is at least N bytes.
    const { text } = input;
    if (text.length > MAX_BRIEF_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BRIEF_BYTES) {
      return {
        ok: false,
        errors: [{ path: 'Text', message: 'the text is too large to be a brief' }],
      };
    }
    return { ok: true, text };
  }
  const path = input.path ?? '';
  const refuse = (message: string): BriefText => ({
    ok: false,
    errors: [{ path: 'File', message }],
  });
  if (!isAbsolute(path)) return refuse(`${path} is not an absolute path`);
  try {
    const info = await stat(path);
    if (!info.isFile()) return refuse(`${path} is not a file`);
    if (info.size > MAX_BRIEF_BYTES) return refuse(`${path} is too large to be a brief`);
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'it does not exist'
        : error instanceof Error
          ? error.message
          : String(error);
    return refuse(`Can't read ${path}: ${reason}`);
  }
}
