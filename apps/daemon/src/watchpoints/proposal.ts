import {
  BuilderOwns,
  CardDecider,
  decisionDetail,
  InboxKind,
  isWatchpointOff,
  ProposalKind,
  QuestionCategory,
  Urgency,
  WatchpointLoudness,
  WatchpointProposalScope,
  type InboxItemDto,
  type ProjectId,
  type ProjectWatchpointEntry,
  type ProposalId,
  type SourceId,
  type Watchpoint,
  type WatchpointProposal,
} from '@10db/contracts';
import {
  insertInboxItem,
  insertProposal,
  readYourWatchpoints,
  storedWatchpointEntry,
  type WriteContext,
} from '@10db/db';
import { quotedWords } from '../knowledge';

/** The most characters a proposal card's title takes. */
const MAX_TITLE = 80;

/** The most characters of one agent-written field the card quotes. */
const MAX_FIELD = 400;

/** The word a watchpoint's loudness reads as on the card. */
const LOUDNESS_WORDS: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'Show',
  [WatchpointLoudness.Ask]: 'Ask',
  [WatchpointLoudness.Hold]: 'Hold',
};

const clipped = (text: string): string =>
  text.length <= MAX_TITLE ? text : `${text.slice(0, MAX_TITLE - 1).trimEnd()}…`;

/** Agent text on one line, quoted, so it can never pass for a line of 10db's own. */
const quoted = (text: string, max = MAX_FIELD): string =>
  quotedWords(text.replace(/\s+/g, ' ').trim(), max);

/** What the change replaces at its scope, and the watchpoint that applies under that key now. */
interface Before {
  /** The entry the list holds for the key; Accept refuses if it has changed since. */
  readonly stored: ProjectWatchpointEntry | null;
  /** The watchpoint that applies now: the stored one, else the builder's that a project entry overrides. */
  readonly applies: Watchpoint | null;
  /** The project turned the builder's watchpoint with this key off. */
  readonly turnedOff: boolean;
}

function before(ctx: WriteContext, projectId: ProjectId, proposal: WatchpointProposal): Before {
  const stored = storedWatchpointEntry(ctx.tx, projectId, proposal.scope, proposal.entry.key);
  const yours = readYourWatchpoints(ctx.tx).find((w) => w.key === proposal.entry.key) ?? null;
  if (stored !== null && !isWatchpointOff(stored))
    return { stored, applies: stored, turnedOff: false };
  if (proposal.scope === WatchpointProposalScope.You)
    return { stored, applies: null, turnedOff: false };
  return { stored, applies: yours, turnedOff: stored !== null };
}

/** The card's title, in 10db's words, naming watchpoints by the agent's label only in quotes. */
function titleOf(proposal: WatchpointProposal, was: Before): string {
  const where = proposal.scope === WatchpointProposalScope.You ? ' in every project' : '';
  const entry = proposal.entry;
  // The label is cut to 30 so the scope words always fit in the title.
  const name = (label: string): string => quoted(label, 30);
  if (isWatchpointOff(entry))
    return clipped(`Stop watching ${name(was.applies?.label ?? entry.key)} here?`);
  if (was.turnedOff) return clipped(`Watch ${name(entry.label)} here again?`);
  return clipped(
    was.applies === null
      ? `Add the watchpoint ${name(entry.label)}${where}?`
      : `Change the watchpoint ${name(was.applies.label)}${where}?`,
  );
}

/** Every field Accept writes, one line each; the agent's words are quoted. */
function describe(w: Watchpoint): string[] {
  return [
    `Name: ${quoted(w.label)} (key ${w.key})`,
    `Files: ${w.globs.map((g) => quoted(g, 200)).join(', ')}`,
    ...(w.lines.length === 0 ? [] : [`Lines: ${w.lines.map((l) => quoted(l, 200)).join(', ')}`]),
    `When it matches: ${LOUDNESS_WORDS[w.loudness]}`,
    ...(w.why === '' ? [] : [`Why it matters, shown to every lane: ${quoted(w.why)}`]),
    ...(w.guidance === '' ? [] : [`What to check, shown to every lane: ${quoted(w.guidance)}`]),
    ...(w.question === null ? [] : [`Judge's question: ${quoted(w.question)}`]),
    ...(w.knowledge.length === 0 ? [] : [`Knowledge topics: ${w.knowledge.join(', ')}`]),
  ];
}

function bodyOf(proposal: WatchpointProposal, was: Before, reason: string): string {
  const entry = proposal.entry;
  const where = proposal.scope === WatchpointProposalScope.You ? 'every project' : 'this project';
  const change = isWatchpointOff(entry)
    ? [`Turns ${quoted(was.applies?.label ?? entry.key)} off in this project.`]
    : [
        was.turnedOff
          ? 'Turns this watchpoint back on in this project, as follows.'
          : was.applies === null
            ? `Adds a watchpoint for ${where}.`
            : `Replaces this watchpoint for ${where}.`,
        ...describe(entry),
        ...(was.applies === null || was.turnedOff ? [] : ['', 'Now:', ...describe(was.applies)]),
      ];
  return [...change, '', `Why, in the agent's words: ${quoted(reason, 2000)}`].join('\n');
}

/**
 * Stores an agent's proposed watchpoint change and the builder card that decides it. Watchpoints are the builder's
 * oversight of the agent, so only the builder's Accept writes the change, and only while the list still holds what
 * the card showed; until then the list is as it was. A starter link is never taken from an agent.
 */
export function proposeWatchpointChange(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly proposal: WatchpointProposal;
    /** The agent's reason. */
    readonly body: string;
    readonly sourceId: SourceId;
  },
): { proposalId: ProposalId; card: InboxItemDto } {
  const proposal: WatchpointProposal = isWatchpointOff(input.proposal.entry)
    ? input.proposal
    : { ...input.proposal, entry: { ...input.proposal.entry, starter: null } };
  const was = before(ctx, input.projectId, proposal);
  const title = titleOf(proposal, was);
  const proposalId = insertProposal(ctx, {
    projectId: input.projectId,
    kind: ProposalKind.Watchpoint,
    title,
    body: input.body,
    sourceId: input.sourceId,
  });
  const card = insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Proposal,
    title,
    body: bodyOf(proposal, was, input.body),
    options: [
      { label: 'accept', description: 'Make the change to your watchpoints' },
      { label: 'reject', description: 'Leave the watchpoints as they are' },
    ],
    recommendation: null,
    category: QuestionCategory.Product,
    urgency: Urgency.Low,
    detail: {
      proposalId,
      proposalKind: ProposalKind.Watchpoint,
      watchpoint: proposal,
      watchpointBefore: was.stored,
      ...decisionDetail({ decider: CardDecider.Builder, owns: BuilderOwns.Guardrails }),
    },
    foldKey: null,
    targets: [],
  });
  return { proposalId, card };
}
