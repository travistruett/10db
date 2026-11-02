import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  InboxKind,
  InboxState,
  PermissionChoice,
  type InboxItemDto,
  type InboxItemId,
  type PermissionRuleDto,
  type WorkstreamId,
} from '@10db/contracts';

/** The tools whose permission cards name the file they write (the broker's edit family). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The states of a permission card its builder has answered. */
export const ANSWERED_STATES = [
  InboxState.Answered,
  InboxState.Delivering,
  InboxState.Resolved,
] as const;

/** How many of a project's latest answered cards are read for an allowance. */
export const ANSWERED_CARDS_READ = 500;

/** A write the builder allowed, as an answered Allow Edit card or a stored rule says. */
export interface EditAllowance {
  /** The card behind it; null for a stored rule. */
  readonly cardId: InboxItemId | null;
  readonly workstreamId: WorkstreamId | null;
  /** What names this allowance's single use; null for a stored rule. */
  readonly useKey: string | null;
  /** The file, as the card or rule names it: absolute, or relative to the lane's checkout. */
  readonly path: string;
  /** Whether it covers every write to the path (a stored rule, or a choice that stored one), not one. */
  readonly standing: boolean;
}

/**
 * The edits the answered permission cards allowed. `allow_once` allows one write; `allow_workstream` and
 * `allow_project` store a rule that allows every later one, so those stand. A card the builder denied, or
 * one that names no file, allows nothing.
 */
export function cardAllowances(items: readonly InboxItemDto[]): EditAllowance[] {
  const allowed: EditAllowance[] = [];
  for (const item of items) {
    if (item.kind !== InboxKind.Permission || !ANSWERED_STATES.some((s) => s === item.state)) {
      continue;
    }
    const choice = item.answer?.choice;
    const once = choice === PermissionChoice.AllowOnce;
    if (
      !once &&
      choice !== PermissionChoice.AllowWorkstream &&
      choice !== PermissionChoice.AllowProject
    ) {
      continue;
    }
    const tool = item.detail?.['toolName'];
    const path = item.detail?.['path'];
    if (typeof tool !== 'string' || !EDIT_TOOLS.has(tool) || typeof path !== 'string') continue;
    // The inbox folds identical cards from several lanes into one, with a target for each lane; the
    // builder's answer allows each of those lanes' write.
    for (const target of item.targets) {
      allowed.push({
        cardId: item.id,
        workstreamId: target.workstreamId,
        useKey: useKey(item.id, target.workstreamId),
        path,
        standing: !once,
      });
    }
  }
  return allowed;
}

/** What names one lane's use of an allow-once card: a folded card allows one write for each lane it targets. */
export function useKey(cardId: InboxItemId, workstreamId: WorkstreamId | null): string {
  return `${cardId}\0${workstreamId ?? ''}`;
}

/** The use keys of every lane the cards target, whether or not they allow an edit. */
export function cardUseKeys(items: readonly InboxItemDto[]): string[] {
  return items.flatMap((i) => i.targets.map((t) => useKey(i.id, t.workstreamId)));
}

/** The stored rules that allow one file's edits: an edit tool's rule scoped to an absolute path. */
export function ruleAllowances(rules: readonly PermissionRuleDto[]): EditAllowance[] {
  return rules
    .filter((r) => EDIT_TOOLS.has(r.toolName) && r.pattern !== null && isAbsolute(r.pattern))
    .map((r) => ({
      cardId: null,
      workstreamId: r.workstreamId,
      useKey: null,
      path: r.pattern ?? '',
      standing: true,
    }));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `path` relative to the checkout `root` with `/`, whether it names the root by its link or its real path; else null. */
export function relativeIn(root: string, path: string): string | null {
  const target = resolve(root, path);
  for (const base of new Set([root, realOrSelf(root)])) {
    const rel = relative(base, target);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return rel.split(sep).join('/');
    }
  }
  return null;
}

/** What identifies the current write to a file: its modification time to the nanosecond, or `gone`. */
export function writeStamp(root: string, rel: string): string {
  try {
    return String(statSync(resolve(root, rel), { bigint: true }).mtimeNs);
  } catch {
    return 'gone';
  }
}
