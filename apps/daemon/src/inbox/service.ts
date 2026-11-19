import { createHash, randomUUID } from 'node:crypto';
import {
  type ConversationId,
  CARD_CLOSES_ITSELF,
  CARD_PROPOSED_PRINCIPLES,
  CARD_RESOLVES_WHEN,
  CARD_RELEASED_WORKSTREAMS,
  CARD_RESOLUTION,
  ReleasedWorkstreams,
  CheckChoice,
  PlanChoice,
  ConflictError,
  DomainError,
  InboxAnswer,
  InboxAnswerRefused,
  InboxKind,
  InboxState,
  JudgeDecision,
  RecordedAnswer,
  type PersonId,
  InvalidError,
  LimitName,
  isParkChoice,
  kindsOfTask,
  MCP_TOOL_GRANT_DETAIL,
  McpToolGrant,
  PermissionChoice,
  ProposalId,
  ProposalKind,
  QuestionCategory,
  SHARED_ASK_REPLY_CHOICE,
  SharedAskDetail,
  Urgency,
  type CardResolution,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type SessionId,
  type ShapeId,
  type WorkstreamId,
  withParkedTasks,
  withParkOption,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getInboxItem,
  getJudgeConfig,
  getPerson,
  sendForCard,
  areasForProposal,
  getProject,
  getProposal,
  getProposalDto,
  getTask,
  getWorkstreamRow,
  passHoldingTask,
  insertDecision,
  insertInboxItem,
  assigneesFor,
  targetTaskIds,
  insertPermissionRule,
  insertSource,
  insertTaskFromProposal,
  listKinds,
  listInbox,
  openItemsForWorkstream,
  resolveProposal,
  updateInboxItem,
  type DbReader,
  type Json,
  type WriteContext,
  insertTrustGrant,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { applyPrincipleCard, proposeStandingRules, recordAnswerDecision } from '../knowledge';
import type { Logger } from '../log';
import { ESCALATED_KEY, EXACT_WRITE_KEY, mcpGrantRules, storableRule } from '../permissions';
import { proposePlacement } from '../placement';
import { grantTargetOf } from '../trust';
import { BY_ANSWER, CardTier, type CardClosesWhen, type StoredTier } from './card-tier';
import { applyDockerChoice } from './docker-card';
import { applyTrustChoice, isSensitiveStray } from './trusted-writes';
import { postNotice, type NoticeInput } from './notice';
import { applyGateHostChoice } from './gate-host-card';
import { applyHazardChoice } from './hazard-card';
import { GRANT_CALL_DETAIL, LIMIT_DETAIL } from './limit-card';
import { applyMcpApproval } from './mcp-approval';
import { declaredKinds, taskFieldsFromProposal } from './proposal-task';

/** The detail key, and fold key prefix, of the flag that offers to deliver a stored answer again. */
const REDELIVER_KEY = 'redeliverCard';

/** Rejects an answer promise when the asking session stops waiting. */
export class ParkedError extends Error {
  override readonly name = 'ParkedError';
  constructor() {
    super('The session stopped waiting for this answer');
  }
}

/**
 * A dismiss of a card that closes when its cause clears. The API answers 409: the card leaves by its
 * closer, so a dismissal never hides a later real ask.
 */
class CardClosesItselfError extends DomainError {
  override readonly name = 'CardClosesItselfError';
  constructor() {
    super('conflict', 'This card closes itself when its cause is gone, so it cannot be dismissed');
  }
}

/**
 * Rejects an answer promise when the asking session is a lane nobody watches and its question stayed
 * with the builder: the caller answers the question at once instead (trust line §5).
 */
export class AnsweredAwayError extends Error {
  override readonly name = 'AnsweredAwayError';
  constructor() {
    super('Nobody watches this task, so its question is answered at once');
  }
}

/**
 * Who waits on a card: a lane's workstream, or a conversation, whose card has no target and names the
 * conversation in its detail (`CONVERSATION_CARD_KEY`), and Plan's shape too (`SHAPE_CARD_KEY`).
 */
type AskOwner =
  | {
      readonly workstreamId: WorkstreamId;
      readonly conversationId?: never;
      readonly shapeId?: never;
    }
  | {
      readonly workstreamId: null;
      readonly conversationId: ConversationId;
      readonly shapeId?: ShapeId;
    };

type AskInput = AskOwner & {
  readonly projectId: ProjectId;
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
  /** The card folds with the open card under this key alone, whatever it says. */
  readonly foldKey?: string;
  /** The topic the lane named from the project's topics; a topic route can match it. */
  readonly topic?: string;
};

/** The detail key naming the Plan conversation whose session asked a card. */
const SHAPE_CARD_KEY = 'shapeId';
/** The detail key naming the conversation whose session asked a card. */
const CONVERSATION_CARD_KEY = 'conversationId';

/** A flag card, as `InboxService.flag` and `flagCard` raise it. */
export interface FlagInput {
  readonly projectId: ProjectId;
  /** What the card asks of the builder; a notice is never stored, so it is not a choice here. */
  readonly tier: StoredTier;
  /** How soon the builder should look (§4.4): work stopped is high, a choice is normal, an undo offer is low. */
  readonly urgency: Urgency;
  /** How the open card closes; an event closer is stored in the detail, where `resolveStaleCards` finds it. */
  readonly closesWhen: CardClosesWhen;
  readonly workstreamId: WorkstreamId | null;
  readonly title: string;
  readonly body: string;
  readonly detail?: Record<string, Json>;
  readonly foldKey?: string;
  /**
   * A repeat that folds replaces the open card's title, body, options and detail, so one with no
   * options or detail clears them. That tells clients it changed.
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

/** What a stakeholder's reply came to once read against the card's options. */
export interface SlackAnswerInput {
  readonly readAs: 'option' | 'own_words' | 'approved';
  /** The option picked or approved; null for words that match none. */
  readonly answer: InboxAnswer | null;
  readonly words: string;
  readonly conversation: readonly { readonly name: string; readonly text: string }[];
}

/** An answer's note is cut here; the words are kept to the schema's limit. */
const NOTE_LIMIT = 4000;
const WORDS_LIMIT = 20_000;

export interface InboxService {
  /** Folds into an open identical card; the returned promise never causes an unhandled rejection. */
  ask(input: AskInput): { item: InboxItemDto; answer: Promise<InboxAnswer> };
  answer(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  /**
   * Answers a question as a stakeholder who replied in Slack (spec §8.3). It refuses a park choice and a
   * person who is not a recipient of the card's send, accepts words that match no option, and stores who
   * answered. It never resolves a live waiter: their sessions are parked and the words reach the lane only
   * in the quoted resume. `inTx` runs in the same transaction, so what it writes stands or falls with the
   * answer. An answered card is a `ConflictError` that changes nothing.
   */
  answerAs(
    id: InboxItemId,
    input: SlackAnswerInput,
    by: { personId: PersonId; permalink: string; with: string[] },
    inTx: (ctx: WriteContext, item: InboxItemDto) => void,
  ): InboxItemDto;
  flag(input: FlagInput): InboxItemDto;
  /** Posts a notice as an event, in one write. */
  notice(input: NoticeInput): void;
  cancelForWorkstream(workstreamId: WorkstreamId): void;
  /**
   * Rewrites an open card's body (a cap card's running overshoot), and its title, options and detail
   * when given, in one write; a closed card is left as it was.
   */
  reword(id: InboxItemId, body: string, card?: Rewording): void;
  /** Closes an open card whose question a later change made moot; a closed card is left as it was. */
  withdraw(id: InboxItemId): void;
  /**
   * Ends the wait of each session `away` names on the open question card `id`, with
   * `AnsweredAwayError`, so each answers at once; a card left with nobody waiting is withdrawn.
   */
  answerAwayWaits(id: InboxItemId, away: (sessionId: SessionId) => boolean): void;
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
  const closesItself = input.closesWhen.by === 'event';
  const stored: Record<string, Json> | null = closesItself
    ? {
        ...input.detail,
        [CARD_RESOLVES_WHEN]: input.closesWhen.when,
        [CARD_CLOSES_ITSELF]: true,
      }
    : (input.detail ?? null);
  if (input.foldKey) {
    const existing = findOpenByFoldKey(ctx.tx, input.projectId, input.foldKey);
    // A condition card is never dismissed, so a repeat is its only way to say something new: it updates
    // in place, and one that says what the card already says changes nothing.
    if (existing && closesItself && !input.refresh && sameCard(existing, input, stored))
      return existing;
    if (existing && !input.refresh && !closesItself) return existing;
    // The repeat says what is in the way now, and a board that watches the card learns the
    // cause came back. It replaces the whole card: one that folds into another with a different
    // cause must not keep the old title or options, or the old detail its answers act on, which a
    // client still showing the old card could otherwise answer.
    if (existing)
      return updateInboxItem(ctx, existing.id, {
        title: input.title,
        body: input.body,
        options: input.options ?? [],
        detail: stored,
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
    urgency: input.urgency,
    detail: stored,
    foldKey: input.foldKey ?? null,
    targets: input.workstreamId ? [{ workstreamId: input.workstreamId, sessionId: null }] : [],
  });
}

/** Whether the open card already says what a repeat of `input` would write. */
function sameCard(
  existing: InboxItemDto,
  input: FlagInput,
  detail: Record<string, Json> | null,
): boolean {
  return (
    existing.title === input.title &&
    existing.body === input.body &&
    JSON.stringify(existing.options) === JSON.stringify(input.options ?? []) &&
    JSON.stringify(existing.detail) === JSON.stringify(detail)
  );
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

/** Whether a lane's run is of a task that a pass holds as a page. */
function askedByPassPage(db: DbReader, workstreamId: WorkstreamId | null): boolean {
  if (workstreamId === null) return false;
  const task = getTask(db, getWorkstreamRow(db, workstreamId).taskId);
  return passHoldingTask(db, task) !== undefined;
}

/** Identical open questions fold into one card; with `foldPerLane`, only one lane's. */
function foldKeyFor(
  input: Pick<
    AskInput,
    | 'projectId'
    | 'workstreamId'
    | 'conversationId'
    | 'kind'
    | 'title'
    | 'body'
    | 'options'
    | 'foldPerLane'
    | 'escalated'
  >,
  recipients: readonly string[],
): string {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const parts = [
    input.projectId,
    // A conversation's card never folds, with a lane's or with its own: two calls a session makes at once
    // each wait on their own card, so one answer can't leave the other waiting.
    ...(input.conversationId === undefined
      ? []
      : [`conversation:${input.conversationId}`, randomUUID()]),
    ...(input.foldPerLane === true && input.workstreamId !== null ? [input.workstreamId] : []),
    // A call Claude Code handed to a person never shares a card with an ordinary ask.
    ...(input.escalated === true ? ['escalated'] : []),
    // Who the rules give a question is part of what it is: one asked of Mark never answers Dana's.
    ...(input.kind === InboxKind.Question ? [[...recipients].sort().join(',')] : []),
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

/**
 * Whether the answer to a lane's question is the choice that parks the task. A pass's shared-area
 * question never parks its page: its asking call takes the choice as Keep It to This Page.
 */
function parksTask(item: InboxItemDto, answer: InboxAnswer): boolean {
  return (
    item.kind === InboxKind.Question &&
    isParkChoice(answer.choice) &&
    !SharedAskDetail.safeParse(item.detail).success
  );
}

interface Waiter {
  resolve(answer: InboxAnswer): void;
  /** Ends the wait with `AnsweredAwayError`. */
  answerAway(): void;
}

/**
 * "Every tool of this server": one project rule for each tool name the server had listed when the card was
 * raised, each tied to the config hash the builder had approved. Nothing is stored when the card carries no
 * grant, so a card that never offered the choice cannot create one.
 */
function applyMcpServerChoice(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const grant = McpToolGrant.safeParse(item.detail?.[MCP_TOOL_GRANT_DETAIL]);
  if (!grant.success) return;
  const rules = mcpGrantRules(grant.data);
  for (const rule of rules) {
    insertPermissionRule(ctx, {
      projectId: item.projectId,
      workstreamId: null,
      toolName: rule.toolName,
      pattern: rule.pattern,
      sourceInboxId: item.id,
    });
  }
  const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: item.id });
  insertDecision(ctx, {
    projectId: item.projectId,
    question: `Allow every ${grant.data.name} tool in this project?`,
    choice: 'Always allow',
    rationale:
      answer.note ??
      `Allowed from the inbox for the ${String(rules.length)} tools the server listed (${rules.map((r) => r.toolName).join(', ')}), while its approved config was ${grant.data.configHash}`,
    decidedBy: 'me',
    scope: 'project',
    area: null,
    sourceId,
  });
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
  if (answer.choice === PermissionChoice.AllowMcpServer) {
    applyMcpServerChoice(ctx, item, answer);
    return;
  }
  if (answer.choice === PermissionChoice.AlwaysInProject) {
    applyGrantChoice(ctx, item, answer, toolName);
    return;
  }
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
 * Always in this project on a limit or an escalation card: a grant of the card's limit, whose target is the
 * builder's note or the call quoted with its tool. A call that can't be kept as written (too long, or holding
 * `$defaults`) needs a note, so the answer is refused without one.
 */
function applyGrantChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
  toolName: string,
): void {
  const call = item.detail?.[GRANT_CALL_DETAIL];
  const target = grantTargetOf(answer.note ?? null, typeof call === 'string' ? call : '', toolName);
  if (target === null || (typeof call !== 'string' && (answer.note ?? '').trim() === ''))
    throw new InvalidError("Say in the note what to allow: this call can't be kept as it is.");
  // The detail is JSON the broker wrote; read the limit back by its schema.
  const limit = z.enum(LimitName).safeParse(item.detail?.[LIMIT_DETAIL]);
  insertTrustGrant(ctx, {
    projectId: item.projectId,
    limit: limit.success ? limit.data : null,
    target,
    sourceInboxId: item.id,
  });
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
    // The task is stored with the areas of the lane that raised it, so the placement rule sees those, as it
    // does the kinds the lane declared, which are kept on the card and the task has.
    const all = listKinds(ctx.tx);
    const kinds = declaredKinds(item.detail, all);
    const project = getProject(ctx.tx, proposal.projectId);
    insertTaskFromProposal(
      ctx,
      {
        proposalId: proposal.id,
        projectId: proposal.projectId,
        ...taskFieldsFromProposal(proposal),
        kinds,
      },
      proposePlacement(project, {
        areas: areasForProposal(ctx.tx, proposal.id, project),
        kinds: kindsOfTask(kinds, all),
      }),
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
  /** Acts on an open plan card's answer as `onCheckAnswer` does a check card's, and closes the card the same way. */
  onPlanAnswer?(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): () => void;
  /**
   * Runs inside the answer's write for a flag whose choice writes rows of its own (Run these now): a
   * throw refuses the answer and keeps the flag open. What it answers runs once the write committed.
   */
  onFlagAnswerInWrite?(
    ctx: WriteContext,
    item: InboxItemDto,
    answer: InboxAnswer,
  ): (() => void) | undefined;
  /**
   * Runs once the builder answered a lane's question with "Park the task" and the card closed with the
   * answer: the run stops and the task is parked. The asking session is not handed the answer, since
   * it is stopped, not told. It must not throw; it logs what it could not do.
   */
  onParkAnswer?(item: InboxItemDto): void;
  /** Where a failure that must not fail the builder's answer is logged. */
  readonly log?: Logger;
  /**
   * Runs inside the write that inserts a new question card. The result runs once that write has
   * committed: it starts the judge's triage, so the network call never sits inside a transaction.
   */
  onQuestionOpened?(ctx: WriteContext, item: InboxItemDto): (() => void) | null;
  /**
   * Parks every session waiting on the card (`Runner.parkFor`). `answerAs` calls it so a stakeholder's
   * words are never handed to a live `ask_human` call.
   */
  parkWaiting?(id: InboxItemId): void;
  /** The daemon was started with `TENDB_JUDGE=off`: no question is left waiting for triage. */
  readonly judgeOff?: boolean;
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

  function deliver(item: InboxItemDto, resolveWaiters = true): InboxItemDto {
    const answer = item.answer;
    if (answer === null) throw new ConflictError(`Inbox item ${item.id} has no answer to deliver`);
    if (item.state === InboxState.Answered) {
      transition(item.id, [InboxState.Answered], InboxState.Delivering);
    }
    // The workstream it concerns acted on the answer when it was given; there is nothing to hand on.
    if (item.kind === InboxKind.Check || item.kind === InboxKind.Plan) {
      return transition(item.id, [InboxState.Delivering], InboxState.Resolved);
    }
    const live = resolveWaiters ? waiters.get(item.id) : undefined;
    waiters.delete(item.id);
    for (const target of item.targets) {
      const waiter = target.sessionId ? live?.get(target.sessionId) : undefined;
      if (waiter) waiter.resolve(answer);
      else deps.onParkedAnswer(target, item);
    }
    // A conversation's session (a Plan's, a chat's) waits with no target, so it is handed the answer
    // here. Its card never folds, so the one waiter is the call that raised it; one that stopped waiting
    // withdrew its card, and a stored rule from the answer still holds.
    if (item.detail?.[CONVERSATION_CARD_KEY] !== undefined)
      for (const waiter of live?.values() ?? []) waiter.resolve(answer);
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
    let covered: InboxItemDto[];
    try {
      covered = listInbox(deps.state.db, {
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
    } catch (error) {
      // Same as a failed release below: the builder's answer is stored and delivered, so it stands. The
      // other lanes' cards stay open for the builder.
      deps.log?.warn({ err: error, cardId: answered.id }, 'could not list the covered edit cards');
      return;
    }
    for (const card of covered) {
      try {
        service.answer(card.id, {
          choice: PermissionChoice.AllowOnce,
          note: 'Covered by the project rule just allowed on another lane’s card',
        });
      } catch (error) {
        // Answered meanwhile: nothing to release. Nothing here may fail the answer the builder already
        // gave, which is stored and delivered.
        if (error instanceof ConflictError) continue;
        deps.log?.warn({ err: error, cardId: card.id }, 'could not release a covered edit card');
        // Two outcomes. A failure before the answer committed leaves that card OPEN, still in the
        // builder's list. A failure in delivery, after it committed, leaves it ANSWERED or DELIVERING:
        // out of their list and redelivered only at a daemon start, so a flag card surfaces it, and
        // answering the flag redelivers.
        flagStuckDelivery(card);
      }
    }
  }

  /**
   * Raises a card for the builder when `card` was answered but its delivery did not finish, so the
   * lane's wait does not outlast the failure unseen. A card still open needs none.
   */
  function flagStuckDelivery(card: InboxItemDto): void {
    try {
      const now = getInboxItem(deps.state.db, card.id);
      if (now.state !== InboxState.Answered && now.state !== InboxState.Delivering) return;
      deps.state.write((ctx) =>
        flagCard(ctx, {
          projectId: now.projectId,
          workstreamId: now.targets[0]?.workstreamId ?? null,
          tier: CardTier.Ask,
          urgency: Urgency.High,
          closesWhen: BY_ANSWER,
          title: 'An answer was stored but not delivered',
          body: `The answer to “${now.title}” was recorded, but handing it to the lane failed, so the lane may still be waiting. Retry delivery once the cause is fixed.`,
          detail: { [REDELIVER_KEY]: now.id },
          foldKey: `${REDELIVER_KEY}:${now.id}`,
          options: [
            { label: 'Retry delivery', description: 'Hand the stored answer to the lane again' },
          ],
          recommendation: 'Retry delivery',
        }),
      );
    } catch (error) {
      deps.log?.warn({ err: error, cardId: card.id }, 'could not flag an undelivered answer');
    }
  }

  /**
   * Whether a question could be triaged now: something is wired to run triage and the judge is on. If
   * not, the lane's tags decide at insert and the card is never pending.
   */
  function judgeCanTriage(db: DbReader): boolean {
    if (deps.onQuestionOpened === undefined || deps.judgeOff === true) return false;
    const config = getJudgeConfig(db);
    return config.enabled && config.decisions[JudgeDecision.QuestionRoute].enabled;
  }

  const service: InboxService = {
    ask(raw) {
      let afterCommit: (() => void) | undefined;
      // Whatever the lane wrote, a question can be answered by parking the task, except a pass
      // page's: a page leaves its pass by Take Out, never by parking.
      const input =
        raw.kind === 'question' && !askedByPassPage(deps.state.db, raw.workstreamId)
          ? { ...raw, options: withParkOption(raw.options) }
          : raw;
      const passPage = askedByPassPage(deps.state.db, raw.workstreamId);
      // A conversation's card has no target: no workstream waits on it, and its session's waiter below
      // is how the answer reaches it.
      const target: InboxTarget | null =
        input.workstreamId === null
          ? null
          : { workstreamId: input.workstreamId, sessionId: input.sessionId };
      const detail =
        input.conversationId === undefined
          ? input.detail
          : {
              ...input.detail,
              [CONVERSATION_CARD_KEY]: input.conversationId,
              ...(input.shapeId === undefined ? {} : { [SHAPE_CARD_KEY]: input.shapeId }),
            };
      const item = deps.state.write((ctx) => {
        const routed = assigneesFor(ctx.tx, {
          projectId: input.projectId,
          kind: input.kind,
          category: input.category,
          topic: input.topic ?? null,
          taskIds: targetTaskIds(ctx.tx, target === null ? [] : [target]),
          passPage,
        });
        // A conversation's card never takes a caller's fold key either: its one waiter is the call that raised it.
        const foldKey =
          input.conversationId === undefined
            ? (input.foldKey ?? foldKeyFor(input, routed.handles))
            : foldKeyFor(input, routed.handles);
        const existing = findOpenByFoldKey(ctx.tx, input.projectId, foldKey);
        if (existing) {
          if (target === null) return existing;
          const others = existing.targets.filter((t) => t.workstreamId !== target.workstreamId);
          const targets = [...others, target];
          return updateInboxItem(ctx, existing.id, {
            targets,
            ...(existing.kind === InboxKind.Question
              ? { options: optionsForTargets(ctx, existing.options, targets) }
              : {}),
          });
        }
        const created = insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          options: input.options,
          recommendation: input.recommendation,
          category: input.category,
          urgency: input.urgency,
          detail,
          foldKey,
          targets: target === null ? [] : [target],
          topic: input.topic ?? null,
          passPage,
          pendingTriage: judgeCanTriage(ctx.tx),
        });
        if (created.kind === InboxKind.Question) {
          afterCommit = deps.onQuestionOpened?.(ctx, created) ?? undefined;
        }
        return created;
      });
      // A callback that throws must not fail the ask: the card is stored and the lane waits on it.
      try {
        afterCommit?.();
      } catch (error) {
        deps.log?.warn({ err: error, cardId: item.id }, 'could not start triage');
      }
      const answer = new Promise<InboxAnswer>((resolve, reject) => {
        const forItem = waiters.get(item.id) ?? new Map<SessionId, Waiter>();
        const onAbort = (): void => {
          forItem.delete(input.sessionId);
          reject(new ParkedError());
        };
        forItem.set(input.sessionId, {
          resolve,
          answerAway: () => {
            input.signal.removeEventListener('abort', onAbort);
            reject(new AnsweredAwayError());
          },
        });
        waiters.set(item.id, forItem);
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
      if (current.kind === InboxKind.Flag && current.state === InboxState.Open) {
        if (
          current.detail?.[CARD_CLOSES_ITSELF] === true &&
          !current.options.some((option) => option.label === answer.choice)
        )
          throw new CardClosesItselfError();
        // Throwing keeps the flag open, as it does for any flag whose answer cannot be acted on.
        const stuck = current.detail?.[REDELIVER_KEY];
        if (typeof stuck === 'string') service.redeliver(stuck as InboxItemId);
        deps.onFlagAnswer?.(current, answer);
      }
      if (current.kind === InboxKind.Check && current.state === InboxState.Open) {
        assertKnownChoice(current, answer);
        // Send Back is the builder's note to the agent; without one the agent has nothing to act on.
        if (answer.choice === CheckChoice.SendBack && (answer.note ?? '').trim() === '') {
          throw new InboxAnswerRefused('Send Back needs a note saying what to change');
        }
      }
      if (current.kind === InboxKind.Plan && current.state === InboxState.Open) {
        assertKnownChoice(current, answer);
        if (answer.choice === PlanChoice.SendBack && (answer.note ?? '').trim() === '') {
          throw new InboxAnswerRefused('Send Back needs a note saying what to change in the plan');
        }
      }
      // A reply to a shared-area question is the builder's words to the agent: it needs some.
      if (
        current.kind === InboxKind.Question &&
        current.state === InboxState.Open &&
        answer.choice === SHARED_ASK_REPLY_CHOICE &&
        SharedAskDetail.safeParse(current.detail).success &&
        (answer.note ?? '').trim() === ''
      )
        throw new InboxAnswerRefused('Reply needs a note saying what to tell the agent');
      let afterCommit: (() => void) | undefined;
      const answered = deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open) {
          throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
        }
        assertKnownChoice(item, answer);
        if (item.kind === InboxKind.Check) afterCommit = deps.onCheckAnswer?.(ctx, item, answer);
        if (item.kind === InboxKind.Plan) afterCommit = deps.onPlanAnswer?.(ctx, item, answer);
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
          applyDockerChoice(ctx, updated, answer);
          applyHazardChoice(ctx, updated, answer);
          // A file that changed under a Trust answer trusts nothing: its card comes back with the new stamp.
          const again = applyTrustChoice(ctx, updated, answer);
          if (again) flagCard(ctx, again);
          afterCommit = deps.onFlagAnswerInWrite?.(ctx, updated, answer);
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

    answerAs(id, input, by, inTx) {
      if (input.answer !== null && isParkChoice(input.answer.choice))
        throw new InvalidError('A stakeholder cannot park the task');
      const current = getInboxItem(deps.state.db, id);
      const send = sendForCard(deps.state.db, id);
      if (!send?.people.some((p) => p.recipient && p.personId === by.personId))
        throw new InvalidError('Only a person the question was sent to can answer it');
      const person = getPerson(deps.state.db, by.personId);
      const words = input.words.slice(0, WORDS_LIMIT);
      let given: InboxAnswer;
      if (input.readAs === 'own_words') {
        given = { choice: `In ${person.name}'s words`, note: input.words.slice(0, NOTE_LIMIT) };
      } else {
        if (input.answer === null) throw new InvalidError('There is no option to record');
        given = { ...input.answer };
        assertKnownChoice(current, given);
      }
      const recorded = RecordedAnswer.parse({
        ...given,
        answeredBy: person.handle,
        via: 'slack',
        words,
        with: by.with,
        conversation: input.conversation.slice(0, 100).map((m) => ({
          name: m.name.slice(0, 200),
          text: m.text.slice(0, 4000),
        })),
      });
      const answered = deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open)
          throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
        const updated = updateInboxItem(ctx, id, { state: InboxState.Answered, answer: recorded });
        if (item.kind === InboxKind.Question && input.readAs !== 'own_words') {
          recordAnswerDecision(ctx, updated, recorded, getProject(ctx.tx, item.projectId), {
            handle: person.handle,
            permalink: by.permalink,
            with: by.with,
          });
        }
        inTx(ctx, updated);
        return updated;
      });
      // Their sessions park first, so each answer reaches the lane through the card and the resume.
      waiters.delete(id);
      deps.parkWaiting?.(id);
      return deliver(answered, false);
    },

    flag(input) {
      return deps.state.write((ctx) => flagCard(ctx, input));
    },

    notice(input) {
      deps.state.write((ctx) => {
        postNotice(ctx, input);
      });
    },

    cancelForWorkstream(workstreamId) {
      deps.state.write((ctx) => {
        for (const item of openItemsForWorkstream(ctx.tx, workstreamId)) {
          if (item.state !== InboxState.Open) continue;
          // A stray write to a sensitive path is the builder's to decide, whatever becomes of the lane.
          if (isSensitiveStray(item)) continue;
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

    answerAwayWaits(id, away) {
      const forItem = waiters.get(id);
      if (forItem === undefined) return;
      const released = [...forItem].filter(([sessionId]) => away(sessionId));
      if (released.length === 0) return;
      for (const [sessionId] of released) forItem.delete(sessionId);
      if (forItem.size === 0) waiters.delete(id);
      const releasedIds = new Set(released.map(([sessionId]) => sessionId));
      deps.state.write((ctx) => {
        // A target parked earlier still waits for the builder's answer, so its card stays.
        const card = getInboxItem(ctx.tx, id);
        if (
          forItem.size === 0 &&
          card.targets.every((t) => t.sessionId !== null && releasedIds.has(t.sessionId))
        )
          withdrawCard(ctx, id);
      });
      for (const [, waiter] of released) waiter.answerAway();
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
