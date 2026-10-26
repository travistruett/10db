import {
  AccountPauseReason,
  EventType,
  WorkstreamState,
  type AccountId,
  type InboxItemId,
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
import { timerAt, type Clock, type Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { AccountCard } from './cards';
import { closePauseCards } from './stale-cards';

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
      readonly card: AccountCard | null;
      readonly data?: Record<string, Json>;
    },
  ): void;
  pausedFor(accountId: AccountId): AccountPause | null;
  /**
   * Whether the account's current pause has yet to card this project; true once per pause and project.
   * In memory, so a restart during a pause may card a project once more.
   */
  firstCard(accountId: AccountId, projectId: ProjectId): boolean;
  /**
   * Lifts the account's pause and closes its pause cards. `only` lifts it only while it is that kind
   * of pause: a card's Resume about a pause that has since been replaced lifts nothing. `answering` is
   * the card being answered, which the inbox closes itself.
   */
  resume(
    accountId: AccountId,
    opts?: { readonly only?: AccountPauseReason | null; readonly answering?: InboxItemId },
  ): void;
  /** Re-arms pauses persisted before a restart. */
  restore(): void;
  stop(): void;
}

const PauseSetting = z.object({
  reason: z.enum(AccountPauseReason),
  until: z.iso.datetime().nullable(),
});
const settingKey = (id: AccountId): string => `account_pause.${id}`;

/** The end of a usage-limit pause; null when there is no pause, it has no end, or it is another kind. */
export function usageLimitEnd(pause: AccountPause | null): Date | null {
  if (!pause) return null;
  switch (pause.reason) {
    case AccountPauseReason.UsageLimit:
      return pause.until;
    case AccountPauseReason.MonthlyCap:
    case AccountPauseReason.Refused:
      return null;
  }
}

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
  // The projects each account's current pause has carded; a new pause starts a new record.
  const carded = new Map<AccountId, Set<ProjectId>>();

  function arm(id: AccountId, pause: AccountPause): void {
    timers.get(id)?.cancel();
    timers.delete(id);
    paused.set(id, pause);
    if (pause.until === null) return;
    timers.set(
      id,
      timerAt(opts.clock, pause.until, () => {
        resume(id);
      }),
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

  function resume(id: AccountId, answering: InboxItemId | null = null): void {
    timers.get(id)?.cancel();
    timers.delete(id);
    const was = paused.get(id);
    paused.delete(id);
    carded.delete(id);
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
      // One pause holds an account, so none is in force now: its usage-limit cards offered moves for a
      // limit that is over, and its cap and refusal cards describe a pause that has ended. This holds
      // whichever pause was lifted, and after a restart that remembers none.
      closePauseCards(ctx, id, answering);
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
      // A pause that outlasts the current one is the same pause; a pause on a free account is new.
      if (!held) carded.set(id, new Set());
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
      const card = at.card;
      if (card) {
        const item = opts.inbox.flag({
          projectId: at.projectId,
          workstreamId: null,
          title: card.title,
          body: card.body,
          detail: card.detail,
          foldKey: card.foldKey,
          ...(card.options ? { options: card.options } : {}),
        });
        // A card still open from an earlier pause folds this one in; it shows the pause in force.
        if (armed && item.body !== card.body) opts.inbox.reword(item.id, card.body);
      }
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
    firstCard(id, projectId) {
      const projects = carded.get(id) ?? new Set<ProjectId>();
      carded.set(id, projects);
      if (projects.has(projectId)) return false;
      projects.add(projectId);
      return true;
    },
    resume(id, { only = null, answering } = {}) {
      const held = paused.get(id);
      if (!held || (only !== null && held.reason !== only)) return;
      resume(id, answering ?? null);
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
