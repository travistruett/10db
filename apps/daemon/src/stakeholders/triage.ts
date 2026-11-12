import {
  InboxState,
  JudgeDecision,
  JudgeOutcome,
  QUESTION_CATEGORY_HINTS,
  RoutedBy,
  type InboxItemDto,
  type InboxItemId,
  type JudgeCallId,
  type PersonId,
} from '@10db/contracts';
import {
  ASKED_TOPIC_KEY,
  assigneesFor,
  BUILDER_HANDLE,
  getGoal,
  getInboxItem,
  getJudgeConfig,
  getPerson,
  getTask,
  listPeople,
  listRoutingRules,
  recordJudgeOutcome,
  setInboxRecipients,
  targetTaskIds,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import { NOBODY, triageOptions } from './triage-options';
import { triageState } from './triage-state';

const QUESTION = "Which of the project's routes answers this question?";

export interface TriageDeps {
  readonly state: StateStore;
  readonly judge: Judge;
  /** Called once a card has left `triage_pending`, whichever way: parks the sessions of a routed card. */
  readonly afterRouted: (id: InboxItemId) => void;
  readonly log: Logger;
}

export interface Triage {
  /** Routes a pending card among the project's category and topic routes. Never throws. */
  run(cardId: InboxItemId): Promise<void>;
}

/** Where a pending card goes, once decided. */
type Verdict =
  | {
      readonly kind: 'route';
      readonly personIds: readonly PersonId[];
      readonly callId: JudgeCallId;
    }
  | { readonly kind: 'builder'; readonly callId: JudgeCallId }
  | {
      readonly kind: 'suggest';
      readonly personIds: readonly PersonId[];
      readonly confidence: number;
      readonly callId: JudgeCallId;
    }
  | { readonly kind: 'fallback' };

const askedTopic = (card: InboxItemDto): string | null => {
  const topic = card.detail?.[ASKED_TOPIC_KEY];
  return typeof topic === 'string' ? topic : null;
};

/** What the lane's own tags give: the topic route's people, else the category's, else the builder. */
function fallbackHandles(db: DbReader, card: InboxItemDto): string[] {
  return assigneesFor(db, {
    projectId: card.projectId,
    kind: card.kind,
    category: card.category,
    topic: askedTopic(card),
    taskIds: targetTaskIds(db, card.targets),
    passPage: false,
  }).handles;
}

export function createTriage(deps: TriageDeps): Triage {
  const { state } = deps;

  function stateText(card: InboxItemDto): string {
    const [taskId] = targetTaskIds(state.db, card.targets);
    const task = taskId === undefined ? null : getTask(state.db, taskId);
    const goal = task?.goalId ? getGoal(state.db, task.goalId) : null;
    return triageState(card, askedTopic(card), task, goal);
  }

  /** The judge's call, and what it means now: the routes are read again after the await. */
  async function decide(card: InboxItemDto): Promise<Verdict> {
    const before = triageOptions(
      listRoutingRules(state.db, card.projectId),
      listPeople(state.db),
      QUESTION_CATEGORY_HINTS,
    );
    const [taskId] = targetTaskIds(state.db, card.targets);
    const answer = await deps.judge.choose({
      decision: JudgeDecision.QuestionRoute,
      state: stateText(card),
      question: QUESTION,
      options: before.options,
      criteria: before.criteria,
      ...(taskId === undefined ? {} : { taskId }),
    });
    if (answer.kind !== 'answered') return { kind: 'fallback' };
    const now = triageOptions(
      listRoutingRules(state.db, card.projectId),
      listPeople(state.db),
      QUESTION_CATEGORY_HINTS,
    );
    const floor = getJudgeConfig(state.db).decisions[JudgeDecision.QuestionRoute].floor;
    const people = answer.choice === NOBODY ? [] : (now.peopleFor[answer.choice] ?? []);
    // A route removed while the judge thought is not one to send the card to.
    if (answer.choice !== NOBODY && people.length === 0) return { kind: 'fallback' };
    if (answer.confidence >= floor) {
      return answer.choice === NOBODY
        ? { kind: 'builder', callId: answer.callId }
        : { kind: 'route', personIds: people, callId: answer.callId };
    }
    return people.length === 0
      ? { kind: 'builder', callId: answer.callId }
      : {
          kind: 'suggest',
          personIds: people,
          confidence: answer.confidence,
          callId: answer.callId,
        };
  }

  /** Writes the verdict in one transaction, so a card leaves `triage_pending` exactly once. */
  function settle(cardId: InboxItemId, verdict: Verdict): boolean {
    return state.write((ctx) => {
      const card = getInboxItem(ctx.tx, cardId);
      // Someone else routed the card while the judge thought (Ask Someone…): that stands, and only the
      // judge's own call is recorded.
      if (card.routedBy !== RoutedBy.TriagePending) {
        if (verdict.kind !== 'fallback')
          recordJudgeOutcome(
            ctx,
            verdict.callId,
            verdict.kind === 'suggest' ? JudgeOutcome.BelowFloor : JudgeOutcome.Acted,
          );
        return false;
      }
      // A card answered or closed meanwhile keeps its recipients; it only stops being pending.
      if (card.state !== InboxState.Open) {
        setInboxRecipients(ctx, cardId, {
          assignees: card.assignees,
          routedBy: RoutedBy.Builder,
          suggestion: null,
        });
        return true;
      }
      const handles = (ids: readonly PersonId[]): string[] =>
        ids.map((id) => getPerson(ctx.tx, id).handle);
      switch (verdict.kind) {
        case 'route':
          setInboxRecipients(ctx, cardId, {
            assignees: handles(verdict.personIds),
            routedBy: RoutedBy.Judge,
            suggestion: null,
          });
          recordJudgeOutcome(ctx, verdict.callId, JudgeOutcome.Acted);
          break;
        case 'builder':
          setInboxRecipients(ctx, cardId, {
            assignees: [BUILDER_HANDLE],
            routedBy: RoutedBy.Builder,
            suggestion: null,
          });
          recordJudgeOutcome(ctx, verdict.callId, JudgeOutcome.Acted);
          break;
        case 'suggest':
          setInboxRecipients(ctx, cardId, {
            assignees: [BUILDER_HANDLE],
            routedBy: RoutedBy.Builder,
            suggestion: { personIds: verdict.personIds, confidence: verdict.confidence },
          });
          recordJudgeOutcome(ctx, verdict.callId, JudgeOutcome.BelowFloor);
          break;
        case 'fallback':
          setInboxRecipients(ctx, cardId, {
            assignees: fallbackHandles(ctx.tx, card),
            routedBy: RoutedBy.Rule,
            suggestion: null,
          });
          break;
        default: {
          const unreachable: never = verdict;
          return unreachable;
        }
      }
      return true;
    });
  }

  return {
    async run(cardId) {
      let settled = false;
      try {
        const card = getInboxItem(state.db, cardId);
        if (card.routedBy !== RoutedBy.TriagePending) return;
        let verdict: Verdict;
        try {
          verdict = await decide(card);
        } catch (error) {
          deps.log.warn({ err: error, cardId }, 'triage fell back to the lane tags');
          verdict = { kind: 'fallback' };
        }
        settled = settle(cardId, verdict);
      } catch (error) {
        deps.log.error({ err: error, cardId }, 'triage could not settle a card');
        try {
          settled = settle(cardId, { kind: 'fallback' });
        } catch (again) {
          deps.log.error({ err: again, cardId }, 'triage left a card pending');
        }
      }
      if (!settled) return;
      try {
        deps.afterRouted(cardId);
      } catch (error) {
        deps.log.error({ err: error, cardId }, 'could not act on a triaged card');
      }
    },
  };
}
