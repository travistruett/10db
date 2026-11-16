import { relative, isAbsolute } from 'node:path';
import {
  ConversationItemKind,
  ToolCallKind,
  ToolCallStatus,
  parseItemBody,
  type ProjectDto,
} from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';
import { classifyPath } from '../guard';

/** The paths, relative to the checkout, of the files the chat's agent edited: done edit calls inside it. */
export function editedPathsOf(
  items: readonly Pick<ConversationItemRow, 'kind' | 'body'>[],
  repoPath: string,
): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== ConversationItemKind.ToolCall) continue;
    const call = parseItemBody(item.kind, item.body);
    if (call.kind !== ToolCallKind.Edit || call.status !== ToolCallStatus.Done) continue;
    const rel = isAbsolute(call.path) ? relative(repoPath, call.path) : call.path;
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    paths.add(rel);
  }
  return [...paths];
}

/**
 * The areas a chat's work touches, for the task Do It makes in a separate copy: the project areas its edits and
 * the folder's uncommitted files fall in, in the project's order; with none, the catch-all, else the first area.
 * Empty only for a project with no areas.
 */
export function areasOfChat(
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  paths: readonly string[],
): string[] {
  const hit = new Set<string>();
  for (const path of paths)
    for (const name of classifyPath(path, project.areas, project.hazards).areas) hit.add(name);
  const named = project.areas.filter((a) => hit.has(a.name)).map((a) => a.name);
  if (named.length > 0) return named;
  const fallback = project.areas.find((a) => a.catchAll === true) ?? project.areas[0];
  return fallback === undefined ? [] : [fallback.name];
}
