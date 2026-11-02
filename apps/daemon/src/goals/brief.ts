import { GoalBrief, type GoalAdoptIssue } from '@10db/contracts';
import { parseDocument } from 'yaml';
import type { z } from 'zod';

// Goals spec docs/superpowers/specs/2026-10-29-10db-goals-design.md §11: a brief is Markdown with
// YAML front matter. Reading it is pure, so a refusal and a dry run write and touch nothing.

export type BriefParse =
  | { readonly ok: true; readonly brief: GoalBrief; readonly notes: string }
  | { readonly ok: false; readonly errors: GoalAdoptIssue[] };

const FRONT_MATTER = 'Front matter';
const BYTE_ORDER_MARK = '﻿';

/**
 * Splits the front matter from the notes below it, parses the front matter as YAML and checks
 * its shape with `GoalBrief`. Every shape error is answered at once; YAML that does not parse
 * answers its first error, since the rest are usually echoes of it.
 */
export function parseBrief(text: string): BriefParse {
  const lines = text.replace(BYTE_ORDER_MARK, '').replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return refusal(
      FRONT_MATTER,
      'The brief must start with a --- line, then YAML, then a closing --- line',
    );
  }
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (close === -1) return refusal(FRONT_MATTER, 'The front matter has no closing --- line');

  const yaml = lines.slice(1, close).join('\n');
  const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
  const yamlError = document.errors[0];
  if (yamlError) {
    // The front matter's first line is the file's second.
    const line = yaml.slice(0, yamlError.pos[0]).split('\n').length + 1;
    return refusal(`${FRONT_MATTER}, line ${String(line)}`, yamlError.message);
  }

  const shape = GoalBrief.safeParse(document.toJS());
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map((issue) => ({
        path: describePath(issue.path),
        message: issue.message,
      })),
    };
  }
  return {
    ok: true,
    brief: shape.data,
    notes: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
  };
}

function refusal(path: string, message: string): BriefParse {
  return { ok: false, errors: [{ path, message }] };
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  cares_most: 'cares most',
  depends_on: 'depends on',
};
const ITEM_NAMES: Readonly<Record<string, string>> = {
  tasks: 'Task',
  criteria: 'Criterion',
  people: 'Person',
};

/** Where a zod issue is, in the words the refusal sheet shows: `Task 3, depends on, item 1`. */
function describePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return FRONT_MATTER;
  const [head, ...rest] = path.map(String);
  const parts: string[] = [];
  const item = ITEM_NAMES[head ?? ''];
  const index = Number(rest[0]);
  if (item !== undefined && rest.length > 0 && Number.isInteger(index)) {
    parts.push(`${item} ${String(index + 1)}`);
    rest.shift();
  } else {
    parts.push(capitalize(FIELD_WORDS[head ?? ''] ?? head ?? ''));
  }
  for (const part of rest) {
    parts.push(
      /^\d+$/.test(part) ? `item ${String(Number(part) + 1)}` : (FIELD_WORDS[part] ?? part),
    );
  }
  return parts.join(', ');
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// --- The rules that need the project --------------------------------------------------------------

export interface BriefProject {
  /** The names of the project's areas. */
  readonly areaNames: readonly string[];
  /** Who an `accept` criterion can name, by handle or by name. */
  readonly people: readonly { readonly handle: string; readonly name: string }[];
}

/**
 * The rules zod cannot see: task keys are unique, every `depends_on` and every `task` or `merged`
 * criterion names a key in the brief, the dependencies have no cycle, every area exists in the
 * project, and every person who accepts a criterion exists. Every breach is answered at once.
 */
export function checkBriefRules(brief: GoalBrief, project: BriefProject): GoalAdoptIssue[] {
  const errors: GoalAdoptIssue[] = [];
  const byKey = new Map<string, GoalBrief['tasks'][number]>();
  brief.tasks.forEach((task, i) => {
    if (byKey.has(task.key)) {
      errors.push({
        path: `Task ${String(i + 1)}, key`,
        message: `another task already has the key ${task.key}`,
      });
    } else byKey.set(task.key, task);
  });

  brief.tasks.forEach((task, i) => {
    for (const key of task.depends_on)
      if (!byKey.has(key))
        errors.push({
          path: `Task ${String(i + 1)}, depends on`,
          message: `no task has the key ${key}`,
        });
  });
  brief.criteria.forEach((criterion, i) => {
    if ('task' in criterion && !byKey.has(criterion.task))
      errors.push({
        path: `Criterion ${String(i + 1)}, task`,
        message: `no task has the key ${criterion.task}`,
      });
  });

  errors.push(...dependencyCycles(brief.tasks, byKey));

  brief.tasks.forEach((task, i) => {
    for (const area of task.areas)
      if (!project.areaNames.includes(area))
        errors.push({
          path: `Task ${String(i + 1)}, areas`,
          message: `the project has no area ${area} (it has ${project.areaNames.join(', ')})`,
        });
  });
  brief.criteria.forEach((criterion, i) => {
    if (criterion.check !== 'accept' || criterion.person === undefined) return;
    const name = criterion.person;
    if (!project.people.some((p) => p.handle === name || p.name === name))
      errors.push({
        path: `Criterion ${String(i + 1)}, person`,
        message: `nobody is called ${name}`,
      });
  });
  return errors;
}

type Task = z.infer<typeof GoalBrief>['tasks'][number];

/** One error per cycle the depth-first walk finds, in brief order, naming the keys round it. */
function dependencyCycles(
  tasks: readonly Task[],
  byKey: ReadonlyMap<string, Task>,
): GoalAdoptIssue[] {
  const errors: GoalAdoptIssue[] = [];
  const position = (task: Task): number => tasks.indexOf(byKey.get(task.key) ?? task);
  const finished = new Set<Task>();
  const stack: Task[] = [];
  const visit = (task: Task): void => {
    if (finished.has(task)) return;
    stack.push(task);
    for (const key of task.depends_on) {
      const next = byKey.get(key);
      if (!next) continue;
      const at = stack.indexOf(next);
      if (at === -1) visit(next);
      else if (next === task)
        errors.push({
          path: `Task ${String(position(task) + 1)}, depends on`,
          message: 'a task cannot depend on itself',
        });
      else {
        const loop = [...stack.slice(at), next];
        errors.push({
          path: `Task ${String(position(next) + 1)}, depends on`,
          message: `these tasks wait on each other: ${loop.map((t) => t.key).join(', ')}`,
        });
      }
    }
    stack.pop();
    finished.add(task);
  };
  // A repeated key is refused apart; walk each key's first task only.
  tasks.filter((t) => byKey.get(t.key) === t).forEach(visit);
  return errors;
}
