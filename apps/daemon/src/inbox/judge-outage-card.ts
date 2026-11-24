import { CARD_OPENS, type ProjectId, Urgency } from '@10db/contracts';
import { findOpenByFoldKey, getTask, getWorkstream, listProjects } from '@10db/db';
import type { StateStore } from '../events';
import type { JudgeOutage, JudgeOutageSink } from '../judge';
import type { InboxService } from './service';
import { CardTier } from './card-tier';

const FOLD_KEY = 'judge-outage';
const RESOLVED = "10db's judge answered again";

/** The project the failing call belonged to, else the first project: the card is the builder's, not a project's. */
function projectOf(state: StateStore, outage: JudgeOutage): ProjectId | undefined {
  try {
    if (outage.taskId !== undefined) return getTask(state.db, outage.taskId).projectId;
    if (outage.workstreamId !== undefined)
      return getWorkstream(state.db, outage.workstreamId).projectId;
  } catch {
    // A task or lane removed since the call: any project carries the card.
  }
  return listProjects(state.db)[0]?.id;
}

/**
 * The one card that says 10db's judge can't answer: what failed, what happens meanwhile and what clears it.
 * It is a status card that closes itself when the judge answers again; a restart during the outage finds
 * and keeps the same card instead of raising a second one.
 */
export function createJudgeOutageCard(deps: {
  readonly state: StateStore;
  readonly inbox: InboxService;
}): JudgeOutageSink {
  const openCards = () =>
    listProjects(deps.state.db).flatMap((p) => {
      const card = findOpenByFoldKey(deps.state.db, p.id, FOLD_KEY);
      return card === undefined ? [] : [card];
    });
  return {
    raise(outage) {
      if (openCards().length > 0) return;
      const projectId = projectOf(deps.state, outage);
      if (projectId === undefined) return;
      deps.inbox.flag({
        projectId,
        workstreamId: null,
        tier: CardTier.Status,
        urgency: Urgency.Normal,
        closesWhen: { by: 'withdrawn', when: 'the judge answers again (judge/outage)' },
        title: "10db's judge can't answer",
        body: [
          `${outage.provider} ${outage.cause}.`,
          'Until it does, the rules decide each case, so more actions are skipped than usually would be.',
          'To fix it: add credits or check the key on that account, or pick another account or model for Decisions in Settings › Decisions. This card closes itself once the judge answers.',
        ].join('\n'),
        detail: { [CARD_OPENS]: { to: 'settings', section: 'decisions', label: 'Open Decisions' } },
        foldKey: FOLD_KEY,
      });
    },
    clear() {
      for (const card of openCards()) deps.inbox.resolve(card.id, RESOLVED);
    },
  };
}
