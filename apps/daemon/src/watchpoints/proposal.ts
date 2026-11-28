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
  type ProposalId,
  type SourceId,
  type Watchpoint,
  type WatchpointProposal,
} from '@10db/contracts';
import {
  insertInboxItem,
  insertProposal,
  readProjectWatchpoints,
  readYourWatchpoints,
  type WriteContext,
} from '@10db/db';
import { quotedWords } from '../knowledge';

/** The most characters a proposal card's title takes. */
const MAX_TITLE = 80;

/** The word a watchpoint's loudness reads as on the card. */
const LOUDNESS_WORDS: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'Show',
  [WatchpointLoudness.Ask]: 'Ask',
  [WatchpointLoudness.Hold]: 'Hold',
};

const clipped = (text: string): string =>
  text.length <= MAX_TITLE ? text : `${text.slice(0, MAX_TITLE - 1).trimEnd()}…`;

/** The watchpoint the change replaces or turns off, where its list has one with the key. */
function current(
  ctx: WriteContext,
  projectId: ProjectId,
  proposal: WatchpointProposal,
): Watchpoint | null {
  const yours = readYourWatchpoints(ctx.tx);
  if (proposal.scope === WatchpointProposalScope.You)
    return yours.find((w) => w.key === proposal.entry.key) ?? null;
  const own = readProjectWatchpoints(ctx.tx, projectId).find((e) => e.key === proposal.entry.key);
  if (own !== undefined && !isWatchpointOff(own)) return own;
  return yours.find((w) => w.key === proposal.entry.key) ?? null;
}

/** The card's title, in 10db's words from the change itself, never the agent's. */
function titleOf(proposal: WatchpointProposal, was: Watchpoint | null): string {
  const where = proposal.scope === WatchpointProposalScope.You ? ' in every project' : '';
  const entry = proposal.entry;
  if (isWatchpointOff(entry)) return clipped(`Stop watching ${was?.label ?? entry.key} here?`);
  return clipped(
    was === null ? `Watch ${entry.label}${where}?` : `Change the ${was.label} watchpoint${where}?`,
  );
}

/** What the watchpoint covers and does, one line each. */
function describe(w: Watchpoint): string[] {
  return [
    `Files: ${w.globs.join(', ')}`,
    ...(w.lines.length === 0 ? [] : [`Lines: ${w.lines.join(', ')}`]),
    `When it matches: ${LOUDNESS_WORDS[w.loudness]}`,
    ...(w.question === null ? [] : [`Judge's question: ${w.question}`]),
    ...(w.guidance === '' ? [] : [`What to check: ${w.guidance}`]),
  ];
}

// The change is shown field by field from the validated edit; the agent's reason is quoted data.
function bodyOf(proposal: WatchpointProposal, was: Watchpoint | null, reason: string): string {
  const entry = proposal.entry;
  const where = proposal.scope === WatchpointProposalScope.You ? 'every project' : 'this project';
  const change = isWatchpointOff(entry)
    ? [`Turns ${was?.label ?? entry.key} off in this project.`]
    : [
        was === null
          ? `Adds a watchpoint for ${where}.`
          : `Replaces the ${was.label} watchpoint for ${where}.`,
        ...describe(entry),
        ...(was === null ? [] : ['', 'Now:', ...describe(was)]),
      ];
  return [...change, '', `Why, in the agent's words: ${quotedWords(reason)}`].join('\n');
}

/**
 * Stores an agent's proposed watchpoint change and the builder card that decides it. Watchpoints are the builder's
 * oversight of the agent, so only the builder's Accept writes the change; until then the list is as it was.
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
  const was = current(ctx, input.projectId, input.proposal);
  const title = titleOf(input.proposal, was);
  const body = bodyOf(input.proposal, was, input.body);
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
    body,
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
      watchpoint: input.proposal,
      ...decisionDetail({ decider: CardDecider.Builder, owns: BuilderOwns.Guardrails }),
    },
    foldKey: null,
    targets: [],
  });
  return { proposalId, card };
}
