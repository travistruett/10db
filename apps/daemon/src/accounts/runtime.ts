import {
  AccountPauseReason,
  type AccountId,
  type AccountRefusal,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import { findOpenByFoldKey, getAccountRow, listProjects, type AccountRow } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import { capStatus } from './cap';
import { accountFoldKey, capCard, refusedCard, usageLimitCard } from './cards';
import type { AccountPause, AccountPauses } from './pauses';
import { unready } from './readiness';
import { closeSettledCards } from './stale-cards';

/** What the scheduler and the runner ask about an account before and after a session. */
export interface AccountRuntime {
  /** Why no session may start on it now: a pause, or its monthly cap (which this call pauses it for). */
  blocked(account: AccountRow, projectId: ProjectId): AccountPause | null;
  /** A usage limit: pauses it until the reset (or the default length) and stops its running lanes. */
  rateLimited(accountId: AccountId, resetsAt: Date | null, projectId: ProjectId): void;
  /** A session on it was refused for its identity or credentials: pauses it until it is saved. */
  refused(account: AccountRow, projectId: ProjectId, refusal: AccountRefusal): void;
  /** A session on it ended: an open cap card shows the spend so far. */
  sessionEnded(account: AccountRow, projectId: ProjectId): void;
  isPaused(accountId: AccountId): boolean;
  /** It was saved: a cap or refusal pause ends, and the next check decides again. */
  saved(accountId: AccountId, answering?: InboxItemId): void;
}

export function createAccountRuntime(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  readonly pauses: AccountPauses;
  readonly defaultPauseMs: number;
}): AccountRuntime {
  const db = opts.state.db;
  // Projects already given the cap card of the account's current cap pause, so a card the builder
  // dismissed is not raised again while the pause lasts.
  const capCarded = new Map<AccountId, Set<ProjectId>>();

  /** A cap pause holds every project on the account; each gets its own card (accounts spec §6). */
  function ensureCapCard(account: AccountRow, projectId: ProjectId, pause: AccountPause): void {
    const seen = capCarded.get(account.id) ?? new Set<ProjectId>();
    capCarded.set(account.id, seen);
    if (seen.has(projectId)) return;
    seen.add(projectId);
    const foldKey = accountFoldKey(account.id, AccountPauseReason.MonthlyCap);
    if (findOpenByFoldKey(db, projectId, foldKey)) return;
    const cap = capStatus(db, account, opts.clock.now());
    if (!cap) return;
    opts.pauses.pause(account.id, pause, {
      projectId,
      card: capCard(account, cap),
      data: { month: cap.window.month, spentUsd: cap.spentUsd, capUsd: cap.capUsd },
    });
  }

  return {
    blocked(account, projectId) {
      const paused = opts.pauses.pausedFor(account.id);
      if (paused) {
        switch (paused.reason) {
          case AccountPauseReason.MonthlyCap:
            ensureCapCard(account, projectId, paused);
            break;
          case AccountPauseReason.UsageLimit:
          case AccountPauseReason.Refused:
            break;
        }
        return paused;
      }
      capCarded.delete(account.id);
      const cap = capStatus(db, account, opts.clock.now());
      if (!cap || cap.spentUsd < cap.capUsd) return null;
      const pause: AccountPause = { reason: AccountPauseReason.MonthlyCap, until: cap.window.end };
      opts.pauses.pause(account.id, pause, {
        projectId,
        card: capCard(account, cap),
        data: { month: cap.window.month, spentUsd: cap.spentUsd, capUsd: cap.capUsd },
      });
      capCarded.set(account.id, new Set([projectId]));
      return pause;
    },
    rateLimited(accountId, resetsAt, projectId) {
      const now = opts.clock.now();
      const until =
        resetsAt && resetsAt > now ? resetsAt : new Date(now.getTime() + opts.defaultPauseMs);
      opts.pauses.pause(
        accountId,
        { reason: AccountPauseReason.UsageLimit, until },
        { projectId, card: usageLimitCard(getAccountRow(db, accountId), until) },
      );
    },
    refused(account, projectId, refusal) {
      opts.pauses.pause(
        account.id,
        { reason: AccountPauseReason.Refused, until: null },
        { projectId, card: refusedCard(account, refusal), data: { problem: refusal.problem } },
      );
    },
    sessionEnded(account) {
      const held = opts.pauses.pausedFor(account.id);
      if (!held) return;
      switch (held.reason) {
        case AccountPauseReason.MonthlyCap: {
          // Spend is account-wide, so every project's cap card shows the same running total.
          const cap = capStatus(db, account, opts.clock.now());
          if (!cap) return;
          const body = capCard(account, cap).body;
          const foldKey = accountFoldKey(account.id, AccountPauseReason.MonthlyCap);
          for (const project of listProjects(db)) {
            if (project.accountId !== account.id) continue;
            const open = findOpenByFoldKey(db, project.id, foldKey);
            if (open) opts.inbox.reword(open.id, body);
          }
          return;
        }
        case AccountPauseReason.UsageLimit:
        case AccountPauseReason.Refused:
          return;
      }
    },
    isPaused: (accountId) => opts.pauses.pausedFor(accountId) !== null,
    saved(accountId, answering) {
      // A ready account no longer needs the cards that asked the builder to make it ready.
      if (!unready(getAccountRow(db, accountId)))
        closeSettledCards(opts.state, accountId, answering);
      const paused = opts.pauses.pausedFor(accountId);
      if (!paused) return;
      switch (paused.reason) {
        case AccountPauseReason.MonthlyCap:
        case AccountPauseReason.Refused:
          opts.pauses.resume(accountId);
          return;
        case AccountPauseReason.UsageLimit:
          return;
      }
    },
  };
}
