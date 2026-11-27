import { z } from 'zod';
import { DecisionRule, type ProjectId } from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

/** The rules the builder set to ask in each project (Ask Me Next Time): project id to rule keys. */
const ASKING_KEY = 'rules.asking';
const Asking = z.record(z.string(), z.array(z.enum(DecisionRule)));

/** The Activity rows whose decision was taken back (Undo), newest last, kept to a bounded tail. */
const UNDONE_KEY = 'activity.undone';
const UNDONE_KEPT = 500;
const Undone = z.array(z.int().positive());

/** A setting that doesn't parse reads as empty: it is a boundary, and a bad value must never stop a rule. */
function readAsking(db: DbReader): z.infer<typeof Asking> {
  const parsed = Asking.safeParse(getAppSetting(db, ASKING_KEY));
  return parsed.success ? parsed.data : {};
}

/** The rules set to ask in a project: their next occurrence is a card, not a notice. */
export function askingRules(db: DbReader, projectId: ProjectId): ReadonlySet<DecisionRule> {
  return new Set(readAsking(db)[projectId] ?? []);
}

/** Whether `rule` is set to ask in the project. */
export function isRuleAsking(db: DbReader, projectId: ProjectId, rule: DecisionRule): boolean {
  return askingRules(db, projectId).has(rule);
}

/** Sets or clears `rule` asking in a project; setting what is already set changes nothing. */
export function setRuleAsking(
  ctx: WriteContext,
  projectId: ProjectId,
  rule: DecisionRule,
  asking: boolean,
): void {
  const all = readAsking(ctx.tx);
  const kept = (all[projectId] ?? []).filter((r) => r !== rule);
  const next = asking ? [...kept, rule] : kept;
  setAppSetting(ctx, ASKING_KEY, { ...all, [projectId]: next });
}

/** The Activity rows (by `seq`) whose decision was undone. */
export function undoneRows(db: DbReader): ReadonlySet<number> {
  const parsed = Undone.safeParse(getAppSetting(db, UNDONE_KEY));
  return new Set(parsed.success ? parsed.data : []);
}

/** Records that an Activity row's decision was taken back, so Undo is not offered twice. */
export function markRowUndone(ctx: WriteContext, seq: number): void {
  const parsed = Undone.safeParse(getAppSetting(ctx.tx, UNDONE_KEY));
  const kept = (parsed.success ? parsed.data : []).filter((s) => s !== seq);
  setAppSetting(ctx, UNDONE_KEY, [...kept, seq].slice(-UNDONE_KEPT));
}
