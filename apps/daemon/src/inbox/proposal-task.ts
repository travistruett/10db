import { z } from 'zod';
import {
  InvalidError,
  ProposalKind,
  RiskTag,
  type ProposalId,
  type TaskDto,
} from '@10db/contracts';
import {
  getProject,
  getProposal,
  insertTaskFromProposal,
  proposalSourceTask,
  resolveProposal,
  type WriteContext,
} from '@10db/db';
import { proposePlacement } from '../placement';

/**
 * The words of a proposal that name a risk when the lane left the tag off. Whole words only, so
 * "author" is not "auth"; a miss costs a card nobody needed, and a hit on a harmless word does too, but
 * a risk filed without a card costs more.
 */
const RISK_WORDS: Readonly<Record<RiskTag, RegExp>> = {
  [RiskTag.Security]: /\b(security|vulnerab\w*|credentials?|secrets?)\b/i,
  [RiskTag.Auth]: /\b(auth|authn|authz|authenticat\w*|authoriz\w*|authoris\w*|oauth|passwords?)\b/i,
  [RiskTag.Migration]: /\bmigrat\w*\b/i,
  [RiskTag.Dependency]: /\b(dependenc\w*|lockfile|package\.json|pnpm-lock\S*)\b/i,
};

/**
 * Files a pending new-task proposal to the Icebox without a card and marks it accepted, in the
 * caller's write. The task's description opens with a line, shown in the task drawer, saying 10db filed
 * it and which task's lane proposed it.
 */
export function fileProposalByItself(ctx: WriteContext, proposalId: ProposalId): TaskDto {
  const proposal = getProposal(ctx.tx, proposalId);
  const lane = proposalSourceTask(ctx.tx, proposalId);
  const fields = taskFieldsFromProposal(proposal);
  const origin = lane
    ? `proposed by the lane working on the task "${lane.title}" (${lane.id})`
    : 'proposed by a lane';
  const task = insertTaskFromProposal(
    ctx,
    {
      proposalId,
      projectId: proposal.projectId,
      title: fields.title,
      description: `Filed by 10db without an Inbox card, ${origin}. It is small and carries no risk tag.\n\n${fields.description}`,
      parkInIcebox: true,
    },
    proposePlacement(getProject(ctx.tx, proposal.projectId), { areas: [], riskTags: [] }),
  );
  resolveProposal(ctx, proposalId, {
    status: 'accepted',
    rationale: 'Filed by 10db: small and no risk tag',
  });
  return task;
}

/**
 * Whether 10db files a lane's proposal itself, and why not when it does not. The reason is a clause
 * that reads after "Raised as a card because" (`proposalCardBody`).
 */
export type ProposalFiling =
  { readonly file: true } | { readonly file: false; readonly reason: string };

/** The card's body: the proposal's own text, then a line saying why it reached the Inbox. */
export function proposalCardBody(body: string, reason: string): string {
  return `${body}\n\nRaised as a card because ${reason}.`;
}

const RiskTagSchema = z.enum(RiskTag);

/**
 * The risk tags a lane declared, kept on the proposal's card so accepting it files a task that
 * carries them. Anything in the card's detail that is not a risk tag is dropped.
 */
export function declaredRiskTags(detail: Readonly<Record<string, unknown>> | null): RiskTag[] {
  const declared: unknown = detail?.['riskTags'];
  if (!Array.isArray(declared)) return [];
  const known = new Set<RiskTag>();
  for (const tag of declared as unknown[]) {
    const parsed = RiskTagSchema.safeParse(tag);
    if (parsed.success) known.add(parsed.data);
  }
  return [...known];
}

/**
 * Decides whether a lane's proposal is filed to the Icebox without a card. Only a new-task proposal
 * can be, and only when the project's limit is above zero, it is no longer than the limit (title and
 * body in characters), it declares no risk tag, its text names none, and it does not ask to join a
 * running batch. Anything else raises the card a person answers. When the proposal declares risk
 * tags, the reason names all of them, then any other rule that also raised the card.
 */
export function proposalFiling(proposal: {
  readonly kind: ProposalKind;
  readonly title: string;
  readonly body: string;
  readonly riskTags?: readonly RiskTag[] | undefined;
  readonly joinsRunningBatch?: boolean | undefined;
  readonly limit: number;
  /** Set when the step the lane is in has already filed as many tasks as a step may. */
  readonly stepCapReached?: boolean | undefined;
}): ProposalFiling {
  const other = firstReasonNotToFile(proposal);
  const declared = [...new Set(proposal.riskTags ?? [])];
  if (declared.length === 0)
    return other === null ? { file: true } : { file: false, reason: other };
  // A declared tag is what the builder most needs to see, so the card names every one of them first,
  // whichever other rule also raised it.
  const carries = `it carries the ${listWords(declared)} risk tag${declared.length === 1 ? '' : 's'}`;
  return { file: false, reason: other === null ? carries : `${carries}, and ${other}` };
}

/** The first rule, other than a declared risk tag, that keeps a proposal from being filed; null when none does. */
function firstReasonNotToFile(proposal: {
  readonly kind: ProposalKind;
  readonly title: string;
  readonly body: string;
  readonly joinsRunningBatch?: boolean | undefined;
  readonly limit: number;
  readonly stepCapReached?: boolean | undefined;
}): string | null {
  if (proposal.kind !== ProposalKind.NewTask) return 'it is not a new task';
  if (proposal.stepCapReached === true)
    return 'this step has already filed as many tasks as a step may, so a person decides';
  if (proposal.limit <= 0) return 'filing small proposals by itself is off for this project';
  if (proposal.joinsRunningBatch === true) return 'it asks to join a running batch';
  const text = `${proposal.title}\n${proposal.body}`;
  for (const tag of Object.values(RiskTag))
    if (RISK_WORDS[tag].test(text)) return `it names the ${tag} risk`;
  if (proposal.title.length + proposal.body.length > proposal.limit)
    return 'it is over the limit for filing by itself';
  return null;
}

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  const last = words.at(-1);
  if (last === undefined || words.length === 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${last}`;
}

/** The longest task title the contract accepts (the Title rule in @10db/contracts). */
const TITLE_MAX = 200;

interface TaskFields {
  readonly title: string;
  readonly description: string;
}

/**
 * The task an accepted proposal files. A task title is one line, so line breaks and control characters
 * become spaces. A title longer than the limit is cut, and its full text leads the description so the
 * cut loses nothing.
 */
export function taskFieldsFromProposal(proposal: {
  readonly title: string;
  readonly body: string;
}): TaskFields {
  const line = proposal.title.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (line === '') throw new InvalidError('A proposal needs a title before it can become a task');
  if (line.length <= TITLE_MAX) return { title: line, description: proposal.body };
  return {
    title: line.slice(0, TITLE_MAX).trimEnd(),
    description: `${proposal.title.trim()}\n\n${proposal.body}`,
  };
}
