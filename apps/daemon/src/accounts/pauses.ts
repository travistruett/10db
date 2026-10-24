import {
  AccountPauseReason,
  EventType,
  WorkstreamState,
  type AccountId,
  type ProjectId,
} from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  getProject,
  listAccounts,
  listWorkstreams,
  setAppSetting,
  transitionWorkstream,
  type Json,
} from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { AccountCard } from './cards';

export interface AccountPause {
  readonly reason: AccountPauseReason;
  /** When it ends; null until the account is saved or its card answered. */
  readonly until: Date | null;
}

export interface AccountPauses {
  /** Pauses the account unless a pause that outlasts this one holds it; the card is raised either way (it folds). */
  pause(
    accountId: AccountId,
    pause: AccountPause,
    at: {
      readonly projectId: ProjectId;
      readonly card: AccountCard;
      readonly data?: Record<string, Json>;
    },
  ): void;
  pausedFor(accountId: AccountId): AccountPause | null;
  resume(accountId: AccountId): void;
  /** Re-arms pauses persisted before a restart. */
  restore(): void;
  stop(): void;
}

const PauseSetting = z.object({
  reason: z.enum(AccountPauseReason),
  until: z.iso.datetime().nullable(),
});
/** Node treats a longer delay as 1 ms, so a long pause re-arms in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const settingKey = (id: AccountId): string => `account_pause.${id}`;

/** A pause with no end outranks one that ends; otherwise the later end wins. */
function outlasts(next: AccountPause, current: AccountPause): boolean {
  if (next.until === null) return current.until !== null;
  if (current.until === null) return false;
  return next.until > current.until;
}

/** One pause per account (accounts spec §3: a usage-limit pause applies to the account that hit it). */
export function createAccountPauses(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  stopAccount(accountId: AccountId): Promise<void>;
  onResume(): void;
}): AccountPauses {
  const paused = new Map<AccountId, AccountPause>();
  const timers = new Map<AccountId, Timer>();

  function arm(id: AccountId, pause: AccountPause): void {
    timers.get(id)?.cancel();
    timers.delete(id);
    paused.set(id, pause);
    if (pause.until === null) return;
    const until = pause.until;
    const remaining = Math.max(0, until.getTime() - opts.clock.now().getTime());
    timers.set(
      id,
      opts.clock.setTimeout(
        () => {
          if (opts.clock.now() >= until) resume(id);
          else arm(id, pause);
        },
        Math.min(remaining, MAX_TIMER_MS),
      ),
    );
  }

  /** The pause in force now; one whose end has passed is resumed here, whether or not its timer fired. */
  function current(id: AccountId): AccountPause | null {
    const pause = paused.get(id);
    if (!pause) return null;
    if (pause.until !== null && pause.until <= opts.clock.now()) {
      resume(id);
      return null;
    }
    return pause;
  }

  function resume(id: AccountId): void {
    timers.get(id)?.cancel();
    timers.delete(id);
    const was = paused.get(id);
    paused.delete(id);
    opts.state.write((ctx) => {
      deleteAppSetting(ctx, settingKey(id));
      for (const ws of listWorkstreams(ctx.tx, { states: [WorkstreamState.PausedLimit] })) {
        if (getProject(ctx.tx, ws.projectId).accountId !== id) continue;
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: { pausedUntil: null },
          reason: 'the account resumed',
        });
      }
      ctx.emit({
        type: EventType.AccountResumed,
        entityType: 'account',
        entityId: id,
        data: { reason: was?.reason ?? null },
      });
    });
    opts.onResume();
  }

  return {
    pause(id, pause, at) {
      const held = current(id);
      const armed = !held || outlasts(pause, held);
      if (armed) {
        arm(id, pause);
        opts.state.write((ctx) => {
          const until = pause.until?.toISOString() ?? null;
          setAppSetting(ctx, settingKey(id), { reason: pause.reason, until });
          const data = { reason: pause.reason, until, ...at.data };
          ctx.emit({ type: EventType.AccountPaused, entityType: 'account', entityId: id, data });
          switch (pause.reason) {
            case AccountPauseReason.MonthlyCap:
              ctx.emit({
                type: EventType.AccountCapReached,
                entityType: 'account',
                entityId: id,
                data,
              });
              break;
            case AccountPauseReason.UsageLimit:
            case AccountPauseReason.Refused:
              break;
          }
        });
      }
      const item = opts.inbox.flag({
        projectId: at.projectId,
        workstreamId: null,
        title: at.card.title,
        body: at.card.body,
        detail: at.card.detail,
        foldKey: at.card.foldKey,
        ...(at.card.options ? { options: at.card.options } : {}),
      });
      // A card still open from an earlier pause folds this one in; it shows the pause in force.
      if (armed && item.body !== at.card.body) opts.inbox.reword(item.id, at.card.body);
      // Only a usage limit stops running sessions; a capped or refused account lets them finish.
      switch (pause.reason) {
        case AccountPauseReason.UsageLimit:
          void opts.stopAccount(id);
          break;
        case AccountPauseReason.MonthlyCap:
        case AccountPauseReason.Refused:
          break;
      }
    },
    pausedFor: (id) => current(id),
    resume(id) {
      if (paused.has(id)) resume(id);
    },
    restore() {
      for (const account of listAccounts(opts.state.db, { includeArchived: true })) {
        const parsed = PauseSetting.safeParse(getAppSetting(opts.state.db, settingKey(account.id)));
        if (!parsed.success) continue;
        const until = parsed.data.until === null ? null : new Date(parsed.data.until);
        if (until !== null && until <= opts.clock.now()) resume(account.id);
        else arm(account.id, { reason: parsed.data.reason, until });
      }
    },
    stop() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
