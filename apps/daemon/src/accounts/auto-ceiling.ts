import {
  CeilingMeasure,
  type AutoCeilingTodayDto,
  isMetered,
  type ProjectId,
  type ProjectDto,
} from '@10db/contracts';
import {
  getAccountRow,
  getAppSetting,
  getProject,
  selfStartedToday,
  setAppSetting,
} from '@10db/db';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { dayOf } from './month';

export { CeilingMeasure };

/** The app setting that holds a project's Carry On Todays for the day they were answered. */
export const autoCeilingDayKey = (projectId: ProjectId): string => `auto_ceiling_day.${projectId}`;

/** What the setting holds: a setting of another day, or one that does not parse, reads as none. */
export const AutoCeilingDay = z.object({ day: z.iso.date(), carryOns: z.int().nonnegative() });
export type AutoCeilingDay = z.infer<typeof AutoCeilingDay>;

export interface CeilingSpent {
  readonly usd: number;
  readonly share: number;
  readonly unmeasured: number;
}

export interface Ceilings {
  readonly usd: number;
  readonly share: number;
  readonly sessions: number;
}

/**
 * The first measure at or past its ceiling, in the order dollars, share, sessions; null while all are
 * under. Each Carry On Today adds one more ceiling's worth of every measure.
 */
export function ceilingStatus(
  spent: CeilingSpent,
  ceilings: Ceilings,
  carryOns: number,
): CeilingMeasure | null {
  const allowance = 1 + carryOns;
  if (spent.usd >= ceilings.usd * allowance) return CeilingMeasure.Usd;
  if (spent.share >= ceilings.share * allowance) return CeilingMeasure.Share;
  if (spent.unmeasured >= ceilings.sessions * allowance) return CeilingMeasure.Sessions;
  return null;
}

/**
 * Whether a run is 10db's own work, which the ceiling holds: one 10db filed and started itself, or the
 * builder's own run that 10db re-runs once after a crash or a stall. Work the builder started is never held.
 */
export function isChecked(row: {
  readonly selfStarted: boolean;
  readonly autoRerun: boolean;
}): boolean {
  return row.selfStarted || row.autoRerun;
}

/** The ceilings a project's three fields hold. */
export const ceilingsOf = (
  project: Pick<ProjectDto, 'autoCeilingUsd' | 'autoCeilingShare' | 'autoCeilingSessions'>,
): Ceilings => ({
  usd: project.autoCeilingUsd,
  share: project.autoCeilingShare,
  sessions: project.autoCeilingSessions,
});

export interface AutoCeiling {
  /** The day's counted sums, the allowance and the measure in use, as Settings › Billing shows them. */
  today(projectId: ProjectId): AutoCeilingTodayDto;
  /** The local day now, as `YYYY-MM-DD`: the day today's count and Carry On Todays belong to. */
  day(): string;
  /** The first measure 10db's own work for the project has reached today; null while it may start. */
  reached(projectId: ProjectId): CeilingMeasure | null;
  /**
   * A Carry On Today answered on `day`: the day's allowance rises by one ceiling's worth of each measure.
   * An answer to a card of an earlier day changes nothing.
   */
  carryOn(projectId: ProjectId, day: string): void;
}

export function createAutoCeiling(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
}): AutoCeiling {
  const db = deps.state.db;

  function carryOnsOn(projectId: ProjectId, day: string): number {
    const stored = AutoCeilingDay.safeParse(getAppSetting(db, autoCeilingDayKey(projectId)));
    return stored.success && stored.data.day === day ? stored.data.carryOns : 0;
  }

  function today(projectId: ProjectId): AutoCeilingTodayDto {
    const window = dayOf(deps.clock.now());
    const project = getProject(db, projectId);
    const spent = selfStartedToday(db, projectId, {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    });
    const carryOns = carryOnsOn(projectId, window.day);
    const reached = ceilingStatus(spent, ceilingsOf(project), carryOns);
    const metered = isMetered(getAccountRow(db, project.accountId).kind);
    const measure = metered
      ? CeilingMeasure.Usd
      : spent.share === 0 && spent.unmeasured > 0
        ? CeilingMeasure.Sessions
        : CeilingMeasure.Share;
    return { day: window.day, ...spent, carryOns, measure, reached };
  }

  return {
    today,
    day: () => dayOf(deps.clock.now()).day,
    reached: (projectId) => today(projectId).reached,
    carryOn(projectId, answered) {
      const day = dayOf(deps.clock.now()).day;
      if (answered !== day) return;
      deps.state.write((ctx) => {
        const stored = AutoCeilingDay.safeParse(
          getAppSetting(ctx.tx, autoCeilingDayKey(projectId)),
        );
        const carryOns = stored.success && stored.data.day === day ? stored.data.carryOns : 0;
        setAppSetting(ctx, autoCeilingDayKey(projectId), { day, carryOns: carryOns + 1 });
      });
    },
  };
}
