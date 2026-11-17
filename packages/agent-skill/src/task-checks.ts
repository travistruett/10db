import { AreaName, TaskInput, TaskPatch, type TaskKind } from '@10db/contracts';
import type { z } from 'zod';
import type { KindView, ProjectView, TaskView } from './api-views';

const taskDraft = TaskInput.strict();
const taskPatch = TaskPatch.strict();

const WHY_REQUIRED =
  'why: say in one sentence why this task matters to the builder (one line, at most 200 characters)';

/** A draft names kinds by key; the daemon takes each with who gave it, and this skill acts for the builder. */
export function withKindObjects(draft: unknown): unknown {
  if (typeof draft !== 'object' || draft === null || !('kinds' in draft)) return draft;
  const { kinds } = draft;
  if (!Array.isArray(kinds)) return draft;
  const objects: unknown[] = kinds.map((key: unknown) =>
    typeof key === 'string' ? ({ key, source: 'builder' } satisfies TaskKind) : key,
  );
  return { ...draft, kinds: objects };
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(draft)'}: ${i.message}`);
}

function unknownKinds(draft: unknown, kinds: readonly KindView[]): string[] {
  if (typeof draft !== 'object' || draft === null || !('kinds' in draft)) return [];
  const known = kinds.map((k) => k.key);
  const given: unknown[] = Array.isArray(draft.kinds) ? draft.kinds : ['(not a list)'];
  return given
    .filter((k) => !known.includes(String(k)))
    .map((k) => `kinds: "${String(k)}" isn't one of ${known.join(', ')}`);
}

/**
 * Every reason a draft would not make a task in `project`: TaskInput's own rules, then what only the live
 * project knows (its areas, its tasks, the kinds). Empty when it is fine.
 */
export function draftProblems(
  draft: unknown,
  project: ProjectView,
  tasks: readonly TaskView[],
  kinds: readonly KindView[],
): string[] {
  const out = unknownKinds(draft, kinds);
  const parsed = taskDraft.safeParse(withKindObjects(draft));
  if (!parsed.success) {
    out.push(...issues(parsed.error).filter((p) => !p.startsWith('kinds')));
    return out;
  }
  // The form leaves why optional for the builder; an agent filing for the builder always says why.
  if (parsed.data.why.trim() === '') out.push(WHY_REQUIRED);
  const areaNames = project.areas.map((a) => a.name);
  for (const a of parsed.data.areas) {
    if (!AreaName.safeParse(a).success || areaNames.includes(a)) continue;
    out.push(`areas: "${a}" isn't one of ${areaNames.join(', ')}`);
  }
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const d of parsed.data.dependsOn) {
    if (!taskIds.has(d)) out.push(`dependsOn: ${d} isn't a task in this project`);
  }
  return out;
}

/** Every reason a patch would not apply: TaskPatch's own rules and the live kinds. Empty when it is fine. */
export function patchProblems(patch: unknown, kinds: readonly KindView[]): string[] {
  const out = unknownKinds(patch, kinds);
  const parsed = taskPatch.safeParse(withKindObjects(patch));
  if (!parsed.success) out.push(...issues(parsed.error).filter((p) => !p.startsWith('kinds')));
  return out;
}
