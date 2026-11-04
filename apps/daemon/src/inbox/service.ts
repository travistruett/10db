import { createHash } from 'node:crypto';
import {
  CARD_PROPOSED_PRINCIPLES,
  CARD_RELEASED_WORKSTREAMS,
  CARD_RESOLUTION,
  ReleasedWorkstreams,
  CheckChoice,
  ConflictError,
  InboxAnswer,
  InboxAnswerRefused,
  InboxKind,
  InboxState,
  InvalidError,
  isParkChoice,
  PermissionChoice,
  ProposalId,
  ProposalKind,
  QuestionCategory,
  Urgency,
  type CardResolution,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
  withParkedTasks,
  withParkOption,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getInboxItem,
  getProject,
  getProposal,
  getProposalDto,
  getTask,
  getWorkstreamRow,
  insertDecision,
  insertInboxItem,
  insertPermissionRule,
  insertSource,
  insertTaskFromProposal,
  listInbox,
  openItemsForWorkstream,
  resolveProposal,
  updateInboxItem,
  type Json,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { applyPrincipleCard, proposeStandingRules, recordAnswerDecision } from '../knowledge';
import type { Logger } from '../log';
import { ESCALATED_KEY, EXACT_WRITE_KEY, storableRule } from '../permissions';
import { proposePlacement } from '../placement';
import { applyGateHostChoice } from './gate-host-card';
import { applyMcpApproval } from './mcp-approval';
import { declaredRiskTags, taskFieldsFromProposal } from './proposal-task';

/** Rejects an answer promise when the asking session stops waiting. */
export class ParkedError extends Error {
  override readonly name = 'ParkedError';
  constructor() {
    super('The session stopped waiting for this answer');
  }
}

interface AskInput {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly kind: 'question' | 'permission';
  readonly title: string;
  readonly body: string;
  readonly options: readonly InboxOption[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
  readonly urgency: Urgency;
  readonly detail: Record<string, Json> | null;
  readonly signal: AbortSignal;
  /** The card folds only with the same lane's identical asks, never with another lane's. */
  readonly foldPerLane?: boolean;
  /** Claude Code's classifier handed the call to a person: the card folds only with other escalated asks. */
  readonly escalated?: boolean;
}

/** A flag card, as `InboxService.flag` and `flagCard` raise it. */
interface FlagInput {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId | null;
  readonly title: string;
  readonly body: string;
  readonly detail?: Record<string, Json>;
  readonly foldKey?: string;
  /**
   * A repeat that folds rewrites the open card's body and detail, which tells clients it changed.
   * Without it a repeat is a silent no-op, which callers that raise on every poll rely on.
   */
  readonly refresh?: boolean;
  readonly options?: readonly InboxOption[];
  /** The label of the option the card recommends. */
  readonly recommendation?: string | null;
}

/** What a reword changes besides the body. */
interface Rewording {
  readonly title?: string;
  readonly options?: readonly InboxOption[];
  readonly detail?: Record<string, Json>;
}

export interface InboxService {
  /** Folds into an open identical card; the returned promise never causes an unhandled rejection. */
  ask(input: AskInput): { item: InboxItemDto; answer: Promise<InboxAnswer> };
  answer(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  flag(input: FlagInput): InboxItemDto;
  cancelForWorkstream(workstreamId: WorkstreamId): void;
  /**
   * Rewrites an open card's body (a cap card's running overshoot), and its title, options and detail
   * when given, in one write; a closed card is left as it was.
   */
  reword(id: InboxItemId, body: string, card?: Rewording): void;
  /** Closes an open card whose question a later change made moot; a closed card is left as it was. */
  withdraw(id: InboxItemId): void;
  /**
   * Closes an open card as RESOLVED by 10db, because the action it reports as failed has succeeded
   * since. The reason goes in `detail.resolution`, where the resolved view shows it; a card that is
   * no longer open is returned as it was.
   */
  resolve(id: InboxItemId, reason: string): InboxItemDto;
  redeliver(id: InboxItemId): InboxItemDto;
}

/**
 * `InboxService.flag`'s write, inside the caller's transaction: a caller that raises a card for a
 * change it records commits both together, or neither.
 */
export function flagCard(ctx: WriteContext, input: FlagInput): InboxItemDto {
  if (input.foldKey) {
    const existing = findOpenByFoldKey(ctx.tx, input.projectId, input.foldKey);
    if (existing && !input.refresh) return existing;
    // The repeat says what is in the way now, and a board that watches the card learns the
    // cause came back.
    if (existing)
      return updateInboxItem(ctx, existing.id, {
        body: input.body,
        ...(input.detail ? { detail: input.detail } : {}),
      });
  }
  return insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Flag,
    title: input.title,
    body: input.body,
    options: input.options ? [...input.options] : [],
    recommendation: input.recommendation ?? null,
    category: QuestionCategory.Other,
    urgency: Urgency.High,
    detail: input.detail ?? null,
    foldKey: input.foldKey ?? null,
    targets: input.workstreamId ? [{ workstreamId: input.workstreamId, sessionId: null }] : [],
  });
}

/** `InboxService.reword`'s write, inside the caller's transaction. */
export function rewordCard(
  ctx: WriteContext,
  id: InboxItemId,
  body: string,
  card?: Rewording,
): void {
  if (getInboxItem(ctx.tx, id).state === InboxState.Open)
    updateInboxItem(ctx, id, { body, ...card });
}

/** `InboxService.withdraw`'s write, inside the caller's transaction. */
export function withdrawCard(ctx: WriteContext, id: InboxItemId): void {
  if (getInboxItem(ctx.tx, id).state === InboxState.Open)
    updateInboxItem(ctx, id, { state: InboxState.Cancelled });
}

/**
 * A question card's options, with Park the task worded for the tasks the card's targets belong to:
 * parking stops every target's run, so a card more than one lane raised says which tasks it parks.
 */
function optionsForTargets(
  ctx: WriteContext,
  options: readonly InboxOption[],
  targets: readonly InboxTarget[],
): InboxOption[] {
  const taskIds = new Set(targets.map((t) => getWorkstreamRow(ctx.tx, t.workstreamId).taskId));
  return withParkedTasks(
    options,
    [...taskIds].map((id) => getTask(ctx.tx, id).title),
  );
}

/** Identical open questions fold into one card; with `foldPerLane`, only one lane's. */
function foldKeyFor(
  input: Pick<
    AskInput,
    | 'projectId'
    | 'workstreamId'
    | 'kind'
    | 'title'
    | 'body'
    | 'options'
    | 'foldPerLane'
    | 'escalated'
  >,
): string {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const parts = [
    input.projectId,
    ...(input.foldPerLane === true ? [input.workstreamId] : []),
    // A call Claude Code handed to a person never shares a card with an ordinary ask.
    ...(input.escalated === true ? ['escalated'] : []),
    input.kind,
    norm(input.title),
    norm(input.body),
    ...input.options.map((o) => norm(o.label)),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** A card with options takes one of them as its choice. */
function assertKnownChoice(item: InboxItemDto, answer: InboxAnswer): void {
  if (item.options.length > 0 && !item.options.some((o) => o.label === answer.choice)) {
    throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
  }
}

/** Whether the answer to a lane's question is the choice that parks the task. */
function parksTask(item: InboxItemDto, answer: InboxAnswer): boolean {
  return item.kind === InboxKind.Question && isParkChoice(answer.choice);
}

interface Waiter {
  resolve(answer: InboxAnswer): void;
}

/**
 * A permission card's choice becomes rules in the answer's own transaction, so the choice holds even
 * when the asking session was parked before the builder answered. A Bash command with no storable
 * prefix, and a sandboxed file path that holds a glob character, get no rule: the choice then
 * behaves as allow-once.
 */
function applyPermissionChoice(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (typeof toolName !== 'string' || typeof summary !== 'string') return;
  const rule = storableRule(toolName, summary);
  if (rule === undefined) return;
  if (answer.choice === PermissionChoice.AllowWorkstream) {
    for (const target of item.targets) {
      insertPermissionRule(ctx, {
        projectId: item.projectId,
        workstreamId: target.workstreamId,
        toolName: rule.toolName,
        pattern: rule.pattern,
        sourceInboxId: item.id,
      });
    }
  }
  if (answer.choice === PermissionChoice.AllowProject) {
    insertPermissionRule(ctx, {
      projectId: item.projectId,
      workstreamId: null,
      toolName: rule.toolName,
      pattern: rule.pattern,
      sourceInboxId: item.id,
    });
    const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: item.id });
    insertDecision(ctx, {
      projectId: item.projectId,
      question: `Allow ${rule.toolName}${rule.pattern ? ` (${rule.pattern})` : ''} in this project?`,
      choice: 'Always allow',
      rationale: answer.note ?? 'Allowed for the project from the inbox',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId,
    });
  }
}

/**
 * A proposal keeps its status and the builder's accept/reject rationale; a resolved one is final. Accepting
 * a new-task proposal files its task in the same transaction, so a task that cannot be filed leaves the
 * proposal pending.
 */
function applyProposalVerdict(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const proposalId = ProposalId.safeParse(item.detail?.['proposalId']);
  if (!proposalId.success) return;
  // A principle proposal's choices are verdicts on its principle, which the knowledge module applies.
  const withPrinciple = getProposalDto(ctx.tx, proposalId.data);
  if (withPrinciple.principle) {
    applyPrincipleCard(ctx, withPrinciple, answer);
    return;
  }
  const proposal = getProposal(ctx.tx, proposalId.data);
  if (proposal.status !== 'pending') {
    throw new ConflictError(`Proposal ${proposal.id} is already ${proposal.status}`);
  }
  const accepted = answer.choice === 'accept';
  resolveProposal(ctx, proposalId.data, {
    status: accepted ? 'accepted' : 'rejected',
    rationale: answer.note ?? null,
  });
  if (accepted && proposal.kind === ProposalKind.NewTask) {
    // A proposal names no areas, so it takes the project's default, by the same rule as any task. The
    // risk tags its lane declared are kept on the card and the task carries them.
    const riskTags = declaredRiskTags(item.detail);
    insertTaskFromProposal(
      ctx,
      {
        proposalId: proposal.id,
        projectId: proposal.projectId,
        ...taskFieldsFromProposal(proposal),
        riskTags,
      },
      proposePlacement(getProject(ctx.tx, proposal.projectId), { areas: [], riskTags }),
    );
  }
}

export function createInboxService(deps: {
  readonly state: StateStore;
  onParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
  /** Acts on an open flag card's answer before it is recorded; throwing keeps the card open. */
  onFlagAnswer?(item: InboxItemDto, answer: InboxAnswer): void;
  /**
   * Acts on an open check card's answer inside the write that closes the card, so the workstream and
   * the card change together; throwing keeps the card open and changes nothing. The result runs once
   * that write has committed. A check card closes with its answer and never reaches `onParkedAnswer`.
   */
  onCheckAnswer?(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): () => void;
  /**
   * Runs once the builder answered a lane's question with "Park the task" and the card closed with the
   * answer: the run stops and the task is parked. The asking session is not handed the answer, since
   * it is stopped, not told. It must not throw; it logs what it could not do.
   */
  onParkAnswer?(item: InboxItemDto): void;
  /** Where a failure that must not fail the builder's answer is logged. */
  readonly log?: Logger;
}): InboxService {
  const waiters = new Map<InboxItemId, Map<SessionId, Waiter>>();

  /** Moves a card to `to` only from one of `from`, checked in the same transaction as the write. */
  function transition(
    id: InboxItemId,
    from: readonly InboxState[],
    to: InboxState,
    answer?: InboxAnswer,
  ): InboxItemDto {
    return deps.state.write((ctx) => {
      const current = getInboxItem(ctx.tx, id);
      if (!from.includes(current.state)) {
        throw new ConflictError(`Inbox item ${id} is already ${current.state}`);
      }
      return updateInboxItem(ctx, id, { state: to, ...(answer ? { answer } : {}) });
    });
  }

  function deliver(item: InboxItemDto): InboxItemDto {
    const answer = item.answer;
    if (answer === null) throw new ConflictError(`Inbox item ${item.id} has no answer to deliver`);
    if (item.state === InboxState.Answered) {
      transition(item.id, [InboxState.Answered], InboxState.Delivering);
    }
    // The workstream it concerns acted on the answer when it was given; there is nothing to hand on.
    if (item.kind === InboxKind.Check) {
      return transition(item.id, [InboxState.Delivering], InboxState.Resolved);
    }
    const live = waiters.get(item.id);
    waiters.delete(item.id);
    for (const target of item.targets) {
      const waiter = target.sessionId ? live?.get(target.sessionId) : undefined;
      if (waiter) waiter.resolve(answer);
      else deps.onParkedAnswer(target, item);
    }
    return transition(item.id, [InboxState.Delivering], InboxState.Resolved);
  }

  /**
   * An edit card folds only within its lane, so two lanes asking for the same edit have a card each. The
   * builder's allow-for-project answer to one stores a rule that covers the other's, so those cards are
   * answered allow_once here: each lane's broker, handed that answer, records the hash of the write its own
   * call makes, as it does for any allowed edit. It stores no rule and no decision of its own. A card that
   * was answered meanwhile is left as it is.
   */
  function releaseCoveredEditCards(answered: InboxItemDto): void {
    const ruleOf = (card: InboxItemDto): ReturnType<typeof storableRule> => {
      const toolName = card.detail?.['toolName'];
      const summary = card.detail?.['summary'];
      return typeof toolName === 'string' && typeof summary === 'string'
        ? storableRule(toolName, summary)
        : undefined;
    };
    const rule = ruleOf(answered);
    if (rule === undefined) return;
    const covered = listInbox(deps.state.db, {
      states: [InboxState.Open],
      projectId: answered.projectId,
    }).filter((card) => {
      if (card.id === answered.id || card.kind !== InboxKind.Permission) return false;
      if (card.detail?.[EXACT_WRITE_KEY] !== true) return false;
      // The classifier handed that call to a person; the stored rule would not have answered it either.
      if (card.detail[ESCALATED_KEY] === true) return false;
      const theirs = ruleOf(card);
      return theirs?.toolName === rule.toolName && theirs.pattern === rule.pattern;
    });
    for (const card of covered) {
      try {
        service.answer(card.id, {
          choice: PermissionChoice.AllowOnce,
          note: 'Covered by the project rule just allowed on another lane’s card',
        });
      } catch (error) {
        // Answered meanwhile: nothing to release. Any other failure leaves that card open for the builder;
        // it must not fail the answer they already gave, which is stored and delivered.
        if (error instanceof ConflictError) continue;
        deps.log?.warn({ err: error, cardId: card.id }, 'could not release a covered edit card');
      }
    }
  }

  const service: InboxService = {
    ask(raw) {
      // Whatever the lane wrote, a question can be answered by parking the task.
      const input =
        raw.kind === 'question' ? { ...raw, options: withParkOption(raw.options) } : raw;
      const foldKey = foldKeyFor(input);
      const target: InboxTarget = { workstreamId: input.workstreamId, sessionId: input.sessionId };
      const item = deps.state.write((ctx) => {
        const existing = findOpenByFoldKey(ctx.tx, input.projectId, foldKey);
        if (existing) {
          const others = existing.targets.filter((t) => t.workstreamId !== input.workstreamId);
          const targets = [...others, target];
          return updateInboxItem(ctx, existing.id, {
            targets,
            ...(existing.kind === InboxKind.Question
              ? { options: optionsForTargets(ctx, existing.options, targets) }
              : {}),
          });
        }
        return insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          options: input.options,
          recommendation: input.recommendation,
          category: input.category,
          urgency: input.urgency,
          detail: input.detail,
          foldKey,
          targets: [target],
        });
      });
      const answer = new Promise<InboxAnswer>((resolve, reject) => {
        const forItem = waiters.get(item.id) ?? new Map<SessionId, Waiter>();
        forItem.set(input.sessionId, { resolve });
        waiters.set(item.id, forItem);
        const onAbort = (): void => {
          forItem.delete(input.sessionId);
          reject(new ParkedError());
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      // A caller may never await this (onWaitStart threw, or the session parked), and an unhandled
      // rejection would take the daemon down. Awaiting callers still see the rejection.
      answer.catch(() => undefined);
      return { item, answer };
    },

    answer(id, raw) {
      const answer = InboxAnswer.parse(raw);
      const current = getInboxItem(deps.state.db, id);
      if (current.kind === InboxKind.Flag && current.state === InboxState.Open)
        deps.onFlagAnswer?.(current, answer);
      if (current.kind === InboxKind.Check && current.state === InboxState.Open) {
        assertKnownChoice(current, answer);
        // Send Back is the builder's note to the agent; without one the agent has nothing to act on.
        if (answer.choice === CheckChoice.SendBack && (answer.note ?? '').trim() === '') {
          throw new InboxAnswerRefused('Send Back needs a note saying what to change');
        }
      }
      let afterCommit: (() => void) | undefined;
      const answered = deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open) {
          throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
        }
        assertKnownChoice(item, answer);
        if (item.kind === InboxKind.Check) afterCommit = deps.onCheckAnswer?.(ctx, item, answer);
        // Parking ends the run, so no session is handed the answer: the card closes with it. It is
        // 10db's control over the run, not the builder's answer to the question, so it is no decision
        // either: the question and answer live only on the parked run's notice.
        const parks = parksTask(item, answer);
        const closesDirectly =
          parks || (item.kind !== InboxKind.Question && item.kind !== InboxKind.Permission);
        let updated = updateInboxItem(ctx, id, {
          state: closesDirectly ? InboxState.Resolved : InboxState.Answered,
          answer,
        });
        if (!parks && item.kind === InboxKind.Question) {
          // Inside this transaction: an area the project lacks refuses the answer and the card stays open.
          recordAnswerDecision(ctx, updated, answer, getProject(ctx.tx, item.projectId));
          const proposed = proposeStandingRules(ctx, updated, answer);
          // The resolved card says a principle was proposed and links to it.
          if (proposed.length > 0) {
            updated = updateInboxItem(ctx, id, {
              detail: { ...updated.detail, [CARD_PROPOSED_PRINCIPLES]: proposed },
            });
          }
        }
        if (item.kind === InboxKind.Permission) applyPermissionChoice(ctx, updated, answer);
        if (item.kind === InboxKind.Proposal) applyProposalVerdict(ctx, updated, answer);
        if (item.kind === InboxKind.Flag) {
          applyMcpApproval(ctx, updated, answer);
          applyGateHostChoice(ctx, updated, answer);
        }
        return updated;
      });
      afterCommit?.();
      if (parksTask(answered, answer)) {
        // The waiting sessions are stopped by the park, never handed the answer.
        waiters.delete(id);
        deps.onParkAnswer?.(answered);
      }
      const delivered = answered.state === InboxState.Resolved ? answered : deliver(answered);
      if (
        answered.kind === InboxKind.Permission &&
        answer.choice === PermissionChoice.AllowProject
      ) {
        releaseCoveredEditCards(answered);
      }
      return delivered;
    },

    flag(input) {
      return deps.state.write((ctx) => flagCard(ctx, input));
    },

    cancelForWorkstream(workstreamId) {
      deps.state.write((ctx) => {
        for (const item of openItemsForWorkstream(ctx.tx, workstreamId)) {
          if (item.state !== InboxState.Open) continue;
          const targets = item.targets.filter((t) => t.workstreamId !== workstreamId);
          updateInboxItem(
            ctx,
            item.id,
            // A cancelled card keeps its target: the Factory's figures attribute its open time by it.
            targets.length === 0
              ? { state: InboxState.Cancelled }
              : {
                  targets,
                  // The lane leaves the card but keeps the minutes it waited on it.
                  detail: {
                    ...item.detail,
                    [CARD_RELEASED_WORKSTREAMS]: [
                      ...new Set([
                        ...(ReleasedWorkstreams.safeParse(item.detail?.[CARD_RELEASED_WORKSTREAMS])
                          .data ?? []),
                        workstreamId,
                      ]),
                    ],
                  },
                  ...(item.kind === InboxKind.Question
                    ? { options: optionsForTargets(ctx, item.options, targets) }
                    : {}),
                },
          );
        }
      });
    },

    reword(id, body, card) {
      deps.state.write((ctx) => {
        rewordCard(ctx, id, body, card);
      });
    },

    withdraw(id) {
      deps.state.write((ctx) => {
        withdrawCard(ctx, id);
      });
    },

    resolve(id, reason) {
      return deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open) return item;
        const resolution: CardResolution = { by: '10db', reason };
        return updateInboxItem(ctx, id, {
          state: InboxState.Resolved,
          detail: { ...item.detail, [CARD_RESOLUTION]: resolution },
        });
      });
    },

    redeliver(id) {
      const item = getInboxItem(deps.state.db, id);
      return item.state === InboxState.Answered || item.state === InboxState.Delivering
        ? deliver(item)
        : item;
    },
  };
  return service;
}
