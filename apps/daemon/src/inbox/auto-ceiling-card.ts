import {
  BuilderOwns,
  CeilingMeasure,
  ProjectId,
  Urgency,
  type AutoCeilingTodayDto,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectDto,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getAccountRow,
  getProject,
  hasAnsweredByFoldKey,
  listOpenByFoldKeyPrefix,
  type Json,
} from '@10db/db';
import { z } from 'zod';
import type { AutoCeiling } from '../accounts';
import type { StateStore } from '../events';
import { CardTier, decidedByBuilder } from './card-tier';
import type { InboxService } from './service';

/** The `detail` key of a ceiling card: the project, the day and the Carry On Todays it was raised under. */
export const AUTO_CEILING_DETAIL = 'autoCeiling';

export const AutoCeilingChoice = { Carry: 'Carry On Today', Wait: 'Wait Until Tomorrow' } as const;
export type AutoCeilingChoice = (typeof AutoCeilingChoice)[keyof typeof AutoCeilingChoice];

const FOLD_PREFIX = 'auto-ceiling:';

/** One card for each project, day and allowance: a Carry On Today makes the next ceiling a new card. */
export const autoCeilingFoldKey = (projectId: ProjectId, day: string, carryOns: number): string =>
  `${FOLD_PREFIX}${projectId}:${day}:${String(carryOns)}`;

const FoldKey = /^auto-ceiling:.+:(\d{4}-\d{2}-\d{2}):\d+$/;

const AutoCeilingCardDetail = z.object({
  projectId: ProjectId,
  day: z.iso.date(),
  carryOns: z.int().nonnegative(),
});

/** A run the ceiling holds, as the card names it. */
export interface WaitingRun {
  readonly title: string;
  /** 10db's own re-run of a run the builder started: its Retry starts it now. */
  readonly rerun: boolean;
}

function dollars(n: number): string {
  return Number.isInteger(n) ? `$${String(n)}` : `$${n.toFixed(2)}`;
}

function percent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

/** What was counted against the measure that was passed, in words. */
function passed(today: AutoCeilingTodayDto, project: ProjectDto): string {
  const allowance = 1 + today.carryOns;
  switch (today.reached) {
    case CeilingMeasure.Usd:
      return `${dollars(today.usd)} of ${dollars(project.autoCeilingUsd * allowance)}`;
    case CeilingMeasure.Share:
      return `${percent(today.share)} of the plan's limit (the ceiling is ${percent(project.autoCeilingShare * allowance)})`;
    case CeilingMeasure.Sessions:
      return `${String(today.unmeasured)} sessions that could not be measured (the ceiling is ${String(project.autoCeilingSessions * allowance)})`;
    case null:
      return 'under its ceiling';
  }
}

/** The card's fields: its title, body, options and the detail its answers read. */
export function autoCeilingCard(input: {
  readonly project: ProjectDto;
  readonly accountLabel: string;
  readonly today: AutoCeilingTodayDto;
  readonly waiting: readonly WaitingRun[];
}): {
  title: string;
  body: string;
  options: InboxOption[];
  detail: Record<string, Json>;
} {
  const { project, today } = input;
  // A project that moved to its fallback account is on a metered one: the dollars are what the card is about.
  const onFallback = project.movedFromAccountId !== null && today.measure === CeilingMeasure.Usd;
  const title = onFallback
    ? `${input.accountLabel} has spent ${dollars(Math.round(today.usd * 100) / 100)} today: carry on or wait for the plan`
    : `${project.name}'s own work reached today's ceiling`;
  const runs = input.waiting
    .map((run) =>
      run.rerun ? `${run.title} (10db's re-run of your run: Retry starts it now)` : run.title,
    )
    .join('; ');
  const body = [
    `10db's own work for ${project.name} (fix tasks it filed, CI fixes and its re-runs) has used ${passed(today, project)} today.`,
    `Running sessions finish; these runs wait: ${runs}. Work you start yourself is never held.`,
    "Carry On Today allows another ceiling of 10db's own work today and starts the waiting runs now. Wait Until Tomorrow leaves them waiting until local midnight.",
  ].join(' ');
  return {
    title,
    body,
    options: [
      {
        label: AutoCeilingChoice.Carry,
        description:
          "Allows another ceiling's worth of 10db's own work today and starts the waiting runs",
      },
      {
        label: AutoCeilingChoice.Wait,
        description: 'Keeps the runs waiting until local midnight',
      },
    ],
    detail: {
      [AUTO_CEILING_DETAIL]: { projectId: project.id, day: today.day, carryOns: today.carryOns },
    },
  };
}

export interface AutoCeilingCards {
  /**
   * Raises the project's card for the runs it holds at today's ceiling: one for each fold key, none once
   * its card was answered, and its runs listed again while it stays open.
   */
  raise(projectId: ProjectId, waiting: readonly WaitingRun[]): void;
  /** Closes the open cards of an earlier day: the runs they held have been released by the new day. */
  closeEarlierDays(): void;
}

export function createAutoCeilingCards(deps: {
  readonly state: StateStore;
  readonly inbox: Pick<InboxService, 'flag' | 'withdraw'>;
  readonly ceiling: Pick<AutoCeiling, 'today' | 'day'>;
}): AutoCeilingCards {
  const db = deps.state.db;
  return {
    raise(projectId, waiting) {
      const today = deps.ceiling.today(projectId);
      if (today.reached === null || waiting.length === 0) return;
      const foldKey = autoCeilingFoldKey(projectId, today.day, today.carryOns);
      if (hasAnsweredByFoldKey(db, projectId, foldKey)) return;
      const project = getProject(db, projectId);
      const card = autoCeilingCard({
        project,
        accountLabel: getAccountRow(db, project.accountId).label,
        today,
        waiting,
      });
      const open = findOpenByFoldKey(db, projectId, foldKey);
      // Written again only when it says something new, so a tick that finds the same runs changes nothing.
      if (open?.body === card.body && open.title === card.title) return;
      deps.inbox.flag({
        projectId,
        tier: CardTier.Ask,
        urgency: Urgency.Normal,
        closesWhen: {
          by: 'withdrawn',
          when: 'a later day closes it (closeEarlierDays); an answer closes it',
        },
        decision: decidedByBuilder(BuilderOwns.Money),
        workstreamId: null,
        title: card.title,
        body: card.body,
        options: card.options,
        detail: card.detail,
        foldKey,
        refresh: open !== undefined,
      });
    },
    closeEarlierDays() {
      const today = deps.ceiling.day();
      for (const open of listOpenByFoldKeyPrefix(db, FOLD_PREFIX)) {
        const day = FoldKey.exec(open.foldKey)?.[1];
        if (day !== undefined && day !== today) deps.inbox.withdraw(open.id);
      }
    },
  };
}

/**
 * Acts on a ceiling card's answer before the inbox records it. Carry On Today raises the day's allowance
 * (`carryOn` also wakes the scheduler); Wait Until Tomorrow changes nothing, and the answered card keeps
 * its fold key, so no tick raises it again that day.
 */
export function createAutoCeilingAnswers(deps: {
  carryOn(projectId: ProjectId, day: string): void;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const parsed = AutoCeilingCardDetail.safeParse(item.detail?.[AUTO_CEILING_DETAIL]);
    if (!parsed.success) return;
    if (answer.choice === AutoCeilingChoice.Carry)
      deps.carryOn(parsed.data.projectId, parsed.data.day);
  };
}
