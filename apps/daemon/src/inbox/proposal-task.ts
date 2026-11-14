import { z } from 'zod';
import {
  InvalidError,
  ProposalKind,
  kindsOfTask,
  withKindsNamed,
  type KindDto,
  type ProposalId,
  type TaskDto,
  type TaskKind,
} from '@10db/contracts';
import {
  areasForProposal,
  getProject,
  getProposal,
  listKinds,
  insertTaskFromProposal,
  proposalSourceTask,
  resolveProposal,
  type WriteContext,
} from '@10db/db';
import { proposePlacement } from '../placement';

/** The kinds a proposal can ask a card for: those that ask for one, by key. */
type KnownKind = Pick<KindDto, 'key' | 'toInbox'>;

/**
 * The words of a proposal that name a risk when the lane left the kind off, by the key of the kind they
 * stand for. Whole words only, so "author" is not "auth"; a miss costs a card nobody needed, and a hit on a
 * harmless word does too, but a risk filed without a card costs more. A kind the builder made has no words.
 */
const RISK_WORDS: Readonly<Record<string, RegExp>> = {
  security: /\b(security|vulnerab\w*|credentials?|secrets?)\b/i,
  auth: /\b(auth|authn|authz|authenticat\w*|authoriz\w*|authoris\w*|oauth|passwords?)\b/i,
  migration: /\bmigrat\w*\b/i,
  dependency: /\b(dependenc\w*|lockfile|package\.json|pnpm-lock\S*)\b/i,
};

/**
 * Files a pending new-task proposal to the Icebox without a card and marks it accepted, in the
 * caller's write. The task's description opens with a line, shown in the task drawer, saying 10db filed
 * it and which task's lane proposed it.
 */
export function fileProposalByItself(
  ctx: WriteContext,
  proposalId: ProposalId,
  kinds: readonly TaskKind[] = [],
): TaskDto {
  const proposal = getProposal(ctx.tx, proposalId);
  const lane = proposalSourceTask(ctx.tx, proposalId);
  const fields = taskFieldsFromProposal(proposal);
  const project = getProject(ctx.tx, proposal.projectId);
  const origin = lane
    ? `proposed by the lane working on the task "${lane.title}" (${lane.id})`
    : 'proposed by a lane';
  const task = insertTaskFromProposal(
    ctx,
    {
      proposalId,
      projectId: proposal.projectId,
      title: fields.title,
      description: `Filed by 10db without an Inbox card, ${origin}. It is small and none of its kinds needs a card.\n\n${fields.description}`,
      parkInIcebox: true,
      kinds,
    },
    // The task is stored with the areas of the lane that raised it, so the rule sees those.
    proposePlacement(project, {
      areas: areasForProposal(ctx.tx, proposalId, project),
      kinds: kindsOfTask(kinds, listKinds(ctx.tx)),
    }),
  );
  resolveProposal(ctx, proposalId, {
    status: 'accepted',
    rationale: 'Filed by 10db: small and no kind that needs a card',
  });
  return task;
}

/**
 * Whether 10db files a lane's proposal itself, and why not when it does not. The reason is a clause
 * that reads after "Raised as a card because" (`proposalCardBody`).
 */
export type ProposalFiling =
  { readonly file: true } | { readonly file: false; readonly reason: string };

/** The line on a card saying why it reached the Inbox. */
export function raisedAsCardLine(reason: string): string {
  return `Raised as a card because ${reason}.`;
}

/** The card's body: the proposal's own text, then the line saying why it reached the Inbox. */
export function proposalCardBody(body: string, reason: string): string {
  return `${body}\n\n${raisedAsCardLine(reason)}`;
}

const KeyList = z.array(z.string().min(1));

/**
 * The kinds a lane declared, kept on the proposal's card so accepting it files a task that has them. The
 * card holds their keys; a card made before kinds holds the risk words the lane declared, which are the
 * keys of the kinds seeded in their place. A key no kind has is dropped, since a task can't name it.
 */
export function declaredKinds(
  detail: Readonly<Record<string, unknown>> | null,
  known: readonly { readonly key: string }[],
): TaskKind[] {
  const keys = [detail?.['kinds'], detail?.['riskTags']].flatMap((held) => {
    const parsed = KeyList.safeParse(held);
    return parsed.success ? parsed.data : [];
  });
  return withKindsNamed([], keys, known, 'agent');
}

/** The declared keys that name a kind asking for a card, each once, in the order declared. */
function askingForCard(declared: readonly string[] | undefined, known: readonly KnownKind[]) {
  const asking = new Set(known.filter((k) => k.toInbox).map((k) => k.key));
  return [...new Set(declared ?? [])].filter((key) => asking.has(key));
}

/**
 * Decides whether a lane's proposal is filed to the Icebox without a card. Only a new-task proposal
 * can be, and only when the project's limit is above zero, it is no longer than the limit (title and
 * body in characters), it declares no kind that asks for a card, its text names none, and it does not ask to join a
 * running batch. Anything else raises the card a person answers. When the proposal declares kinds that
 * ask for a card, the reason names all of them, then any other rule that also raised the card.
 */
export function proposalFiling(proposal: {
  readonly kind: ProposalKind;
  readonly title: string;
  readonly body: string;
  /** The keys of the kinds the lane declared. */
  readonly kinds?: readonly string[] | undefined;
  /** The builder's kinds: which of them ask for a card decides this. */
  readonly known: readonly KnownKind[];
  readonly joinsRunningBatch?: boolean | undefined;
  readonly limit: number;
  /** Set when the step the lane is in has already filed as many tasks as a step may. */
  readonly stepCapReached?: boolean | undefined;
}): ProposalFiling {
  const carries = carriesKinds(proposal.kinds, proposal.known);
  const structural = structuralReason(proposal);
  // A risk the lane declared is stated once, in the clause naming the kinds; this one names only the
  // risks its text mentions that it did not declare.
  const named = namesRisks(undeclaredRisksNamed(proposal));
  // Over the limit only counts when nothing else already sends the proposal to a person.
  const size =
    structural === null &&
    named === null &&
    proposal.title.length + proposal.body.length > proposal.limit
      ? 'it is over the limit for filing by itself'
      : null;
  // A declared kind is what the builder most needs to see, so the card names every one of them first,
  // whichever other rule also raised it.
  const clauses = [carries, structural, named, size].filter((c): c is string => c !== null);
  // The step cap is the last rule: it only names a proposal that would otherwise have been filed, so
  // a risk, a size or a batch request is never hidden behind it.
  if (clauses.length === 0 && proposal.stepCapReached === true)
    return { file: false, reason: STEP_CAP_REASON };
  return clauses.length === 0 ? { file: true } : { file: false, reason: clauses.join(', and ') };
}

const STEP_CAP_REASON =
  'this step has already filed as many tasks as a step may, so a person decides';

/** The clause naming every declared kind that asks for a card; null when none does. */
export function carriesKinds(
  declared: readonly string[] | undefined,
  known: readonly KnownKind[],
): string | null {
  const asking = askingForCard(declared, known);
  if (asking.length === 0) return null;
  return `it carries the ${listWords(asking)} kind${asking.length === 1 ? '' : 's'}`;
}

/** The first kind, limit or batch rule that keeps a proposal from being filed; null when none does. */
function structuralReason(proposal: {
  readonly kind: ProposalKind;
  readonly joinsRunningBatch?: boolean | undefined;
  readonly limit: number;
}): string | null {
  if (proposal.kind !== ProposalKind.NewTask) return 'it is not a new task';
  if (proposal.limit <= 0) return 'filing small proposals by itself is off for this project';
  if (proposal.joinsRunningBatch === true) return 'it asks to join a running batch';
  return null;
}

/** The risks the proposal's text names, for kinds that ask for a card, that its lane did not declare, once each. */
function undeclaredRisksNamed(proposal: {
  readonly title: string;
  readonly body: string;
  readonly kinds?: readonly string[] | undefined;
  readonly known: readonly KnownKind[];
}): string[] {
  const declared = new Set(proposal.kinds);
  const asking = new Set(proposal.known.filter((k) => k.toInbox).map((k) => k.key));
  const text = `${proposal.title}
${proposal.body}`;
  return Object.entries(RISK_WORDS)
    .filter(([key, words]) => asking.has(key) && !declared.has(key) && words.test(text))
    .map(([key]) => key);
}

/** The clause naming risks the text mentions; null when there are none. */
function namesRisks(risks: readonly string[]): string | null {
  if (risks.length === 0) return null;
  return `it names the ${listWords(risks)} risk${risks.length === 1 ? '' : 's'}`;
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
