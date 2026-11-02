import { EventType, STOCK_HAZARD_REVISIONS, type HazardDef } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getAppSetting, setAppSetting } from './settings';
import type { WriteContext } from './store';

/** How many of `STOCK_HAZARD_REVISIONS` this database's projects have had added. */
export const STOCK_HAZARD_REVISION_KEY = 'hazards.stock_revision';

/** Whether the stored hazards hold any command of the revision: they were stored after it. */
function holdsRevision(
  hazards: readonly HazardDef[],
  revision: (typeof STOCK_HAZARD_REVISIONS)[number],
): boolean {
  return hazards.some((h) => (revision[h.name] ?? []).some((c) => h.commands.includes(c)));
}

/**
 * The revisions a project was stored with when the database never recorded one: up to the latest
 * whose commands its hazards hold any of. Removing every command of a revision reads as never having
 * had it, which only this first count can mistake.
 */
function inferredRevision(hazards: readonly HazardDef[]): number {
  return STOCK_HAZARD_REVISIONS.findLastIndex((r) => holdsRevision(hazards, r)) + 1;
}

/**
 * Adds the stock hazard commands of each revision the database has not had to every project's
 * stored hazard of the same name, after the commands it has, and records that it has them all. A
 * command the builder removed later is not added again, and a hazard the builder renamed, removed
 * or added is left alone. Runs at each daemon start, after the migrations.
 */
export function addStockHazardCommands(ctx: WriteContext): void {
  const latest = STOCK_HAZARD_REVISIONS.length;
  const stored = getAppSetting(ctx.tx, STOCK_HAZARD_REVISION_KEY);
  const recorded = typeof stored === 'number' ? stored : null;
  if (recorded !== null && recorded >= latest) return;
  const projects = ctx.tx
    .select({ id: schema.projects.id, hazards: schema.projects.hazards })
    .from(schema.projects)
    .all();
  for (const project of projects) {
    const from = recorded ?? inferredRevision(project.hazards);
    const revisions = STOCK_HAZARD_REVISIONS.slice(from);
    const hazards = project.hazards.map((hazard) => {
      const added = revisions
        .flatMap((r) => r[hazard.name] ?? [])
        .filter((c, i, all) => !hazard.commands.includes(c) && all.indexOf(c) === i);
      return added.length === 0 ? hazard : { ...hazard, commands: [...hazard.commands, ...added] };
    });
    if (hazards.every((hazard, i) => hazard === project.hazards[i])) continue;
    ctx.tx
      .update(schema.projects)
      .set({ hazards, updatedAt: ctx.now })
      .where(eq(schema.projects.id, project.id))
      .run();
    ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: project.id });
  }
  setAppSetting(ctx, STOCK_HAZARD_REVISION_KEY, latest);
}
