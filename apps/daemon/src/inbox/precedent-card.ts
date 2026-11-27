import {
  CARD_RESOLUTION,
  ConflictError,
  InboxState,
  InvalidError,
  LimitName,
  PRECEDENT_CARD_DETAIL,
  PrecedentChoice,
  PrecedentKind,
  PrecedentState,
  TrustPrecedentId,
  Urgency,
  type CardResolution,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type PrecedentAnswer,
  type PrecedentCandidateDto,
  type ProjectId,
  type TrustPrecedentDto,
} from '@10db/contracts';
import {
  approvePrecedent,
  findOpenByFoldKey,
  getProject,
  listPrecedentStops,
  listPrecedents,
  setPrecedent,
  updateInboxItem,
  type WriteContext,
} from '@10db/db';
import { LIMITS } from '../trust';
import { BY_ANSWER, CardTier } from './card-tier';
import { postNotice } from './notice';
import { flagCard } from './service';

// One card per project proposes the kinds of command 10db's judge keeps doubting. The answer writes the rows and
// rewords or resolves the card in the same write; nothing here writes a trust grant.

/** The fold key of a project's proposal card. */
export const precedentFoldKey = (projectId: ProjectId): string => `precedent:${projectId}`;
/** The fold key of the card raised when a precedent is paused. */
export const precedentConflictFoldKey = (id: TrustPrecedentId): string =>
  `precedent-conflict:${id}`;

/** The detail key naming the precedent a conflict card is about. */
export const PRECEDENT_CONFLICT_DETAIL = 'precedentConflict';

/** The answers of a conflict card; the card shows them as written. */
export const PrecedentConflictChoice = {
  Keep: 'Keep',
  Edit: 'Edit',
  Remove: 'Remove',
} as const;
export type PrecedentConflictChoice =
  (typeof PrecedentConflictChoice)[keyof typeof PrecedentConflictChoice];

/** The stops a conflict card lists. */
const CONFLICT_CALLS_SHOWN = 3;
/** The most characters of an agent's call or a key a card's text quotes. */
const QUOTED_MAX = 200;
const TITLE_KEY_MAX = 80;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const quoted = (text: string): string => JSON.stringify(oneLine(text).slice(0, QUOTED_MAX));
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const sameKind = (a: { programKey: string; scope: string }, b: typeof a): boolean =>
  a.programKey === b.programKey && a.scope === b.scope;

function candidateLines(c: PrecedentCandidateDto): string[] {
  const where = c.scope === 'copy' ? 'in a copy' : 'in the project';
  const lines = [
    `- ${oneLine(c.kind)}`,
    `  ${String(c.skips)} ${plural(c.skips, 'skip', 'skips')}, ${String(c.runCount)} ${plural(c.runCount, 'run', 'runs')}, ${String(c.taskCount)} ${plural(c.taskCount, 'task', 'tasks')}, ${where}`,
  ];
  if (c.examples.length > 0) lines.push(`  For example ${c.examples.map(quoted).join(' and ')}`);
  if (c.topWorry !== null)
    lines.push(
      `  The judge's top worry: ${LIMITS[c.topWorry.limit].label}, ${String(Math.round(c.topWorry.p * 100))}%`,
    );
  if (c.stoppedAtLimit.length > 0)
    lines.push(
      `  Warning: a call of this kind was stopped at ${c.stoppedAtLimit.join(', ')} in the last 30 days.`,
    );
  return lines;
}

/** Closes an open card as 10db's own act, in the caller's write, as `InboxService.resolve` does. */
function resolveInWrite(ctx: WriteContext, item: InboxItemDto, reason: string): void {
  if (item.state !== InboxState.Open) return;
  const resolution: CardResolution = { by: '10db', reason };
  updateInboxItem(ctx, item.id, {
    state: InboxState.Resolved,
    detail: { ...item.detail, [CARD_RESOLUTION]: resolution },
  });
}

/**
 * Raises, rewords in place, or resolves the project's proposal card for `candidates`. Every candidate whose key
 * and scope have a row in any state is dropped first, read inside this write, so a refresh computed before an
 * answer can't offer a kind that answer settled. A card that already says what it would say is left alone.
 */
export function refreshPrecedentCard(
  ctx: WriteContext,
  projectId: ProjectId,
  candidates: readonly PrecedentCandidateDto[],
): void {
  const rows = listPrecedents(ctx.tx, projectId);
  const offered = candidates.filter((c) => !rows.some((r) => sameKind(r, c)));
  const existing = findOpenByFoldKey(ctx.tx, projectId, precedentFoldKey(projectId));
  if (offered.length === 0) {
    if (existing !== undefined) resolveInWrite(ctx, existing, 'Nothing is left to make routine.');
    return;
  }
  const skips = offered.reduce((sum, c) => sum + c.skips, 0);
  const runs = offered.reduce((sum, c) => sum + c.runCount, 0);
  const only = offered.length === 1 ? offered[0] : undefined;
  const skipping =
    only === undefined
      ? `${String(offered.length)} kinds of command`
      : oneLine(only.kind).slice(0, TITLE_KEY_MAX);
  const title = `Stop skipping ${skipping} in ${getProject(ctx.tx, projectId).name}? ${String(skips)} ${plural(skips, 'skip', 'skips')} in ${String(runs)} ${plural(runs, 'run', 'runs')}`;
  const body = [
    `${String(skips)} skipped ${plural(skips, 'call', 'calls')} in ${String(runs)} ${plural(runs, 'run', 'runs')}.`,
    'Each kind the judge keeps doubting is below. A kind you approve is a standing approval the judge weighs on every later call; it never lets a call cross a limit.',
    '',
    ...offered.flatMap((c) => [...candidateLines(c), '']),
  ]
    .join('\n')
    .trimEnd();
  if (existing?.title === title && existing.body === body) return;
  flagCard(ctx, {
    projectId,
    workstreamId: null,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    title,
    body,
    options: [],
    recommendation: null,
    detail: { [PRECEDENT_CARD_DETAIL]: projectId },
    foldKey: precedentFoldKey(projectId),
    refresh: true,
  });
}

/**
 * The builder's answer to the card, in its own write: Approve writes an `active` row and Keep Skipping a
 * `declined` one, each with the candidate's examples and hash and the edited kind; Report writes nothing. A kind
 * that already has a row (an earlier answer, or Settings) is left as it is, so the same answer sent twice changes
 * nothing. A kind that is neither on offer nor settled is a `ConflictError` and nothing is written. Then the card
 * is refreshed in the same write. Answers the rows it wrote.
 */
export function applyPrecedentAnswer(
  ctx: WriteContext,
  projectId: ProjectId,
  answer: PrecedentAnswer,
  candidates: readonly PrecedentCandidateDto[],
): TrustPrecedentDto[] {
  const rows = listPrecedents(ctx.tx, projectId);
  const card = findOpenByFoldKey(ctx.tx, projectId, precedentFoldKey(projectId));
  const written: TrustPrecedentDto[] = [];
  const handled: { programKey: string; scope: string }[] = [];
  for (const entry of answer.kinds) {
    if (handled.some((h) => sameKind(h, entry))) continue;
    handled.push(entry);
    if (rows.some((r) => sameKind(r, entry))) continue;
    const candidate = candidates.find((c) => sameKind(c, entry));
    if (candidate === undefined)
      throw new ConflictError('A kind on this answer is not offered any more. Look again.');
    if (entry.choice === PrecedentChoice.Report) continue;
    written.push(
      approvePrecedent(ctx, {
        projectId,
        programKey: candidate.programKey,
        scope: candidate.scope,
        kind: entry.kind ?? candidate.kind,
        examples: candidate.examples,
        runsHash: candidate.runsHash,
        state:
          entry.choice === PrecedentChoice.Approve
            ? PrecedentState.Active
            : PrecedentState.Declined,
        sourceInboxId: card?.id ?? null,
      }),
    );
  }
  refreshPrecedentCard(ctx, projectId, candidates);
  return written;
}

const CONFLICT_OPTIONS: readonly InboxOption[] = [
  {
    label: PrecedentConflictChoice.Keep,
    description: 'Keep it standing; the count of stops starts again from none',
  },
  {
    label: PrecedentConflictChoice.Edit,
    description: 'Say in the note what kind of command it should be, then keep it standing',
  },
  {
    label: PrecedentConflictChoice.Remove,
    description: 'Stop treating this kind of command as routine',
  },
];

const limitLabel = (limit: string): string => {
  const known = Object.values(LimitName).find((name) => name === limit);
  return known === undefined ? limit : LIMITS[known].label;
};

/**
 * Raises the card for a precedent a third conflict paused, in the caller's write: it names the calls 10db
 * stopped at a limit while the precedent seemed to apply, and offers Keep, Edit and Remove. Nothing is raised for
 * a precedent that is not paused.
 */
export function raisePrecedentConflict(
  ctx: WriteContext,
  projectId: ProjectId,
  id: TrustPrecedentId,
): void {
  const row = listPrecedents(ctx.tx, projectId).find((r) => r.id === id);
  if (row?.state !== PrecedentState.Paused) return;
  const stops = listPrecedentStops(
    ctx.tx,
    projectId,
    row.programKey,
    // Stops since it was last approved or kept; a paused row was active, so it has the date.
    row.approvedAt ?? row.createdAt,
    CONFLICT_CALLS_SHOWN,
  );
  const limits = [...new Set(stops.map((s) => limitLabel(s.limit)))];
  const key = oneLine(row.programKey).slice(0, TITLE_KEY_MAX);
  flagCard(ctx, {
    projectId,
    workstreamId: null,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    title: `The standing approval for \`${key}\` matched ${String(row.conflicts)} calls 10db stopped${limits.length === 0 ? '' : ` at ${limits.join(', ')}`}`,
    body: [
      `The standing approval for ${quoted(row.kind)} is paused: calls of this kind go back to being judged without it.`,
      ...(stops.length === 0
        ? []
        : [
            '',
            'Calls it was stopped on:',
            ...stops.map((s) => `- ${quoted(s.call ?? '(unreadable)')}`),
          ]),
    ].join('\n'),
    options: CONFLICT_OPTIONS,
    recommendation: null,
    detail: { [PRECEDENT_CONFLICT_DETAIL]: id },
    foldKey: precedentConflictFoldKey(id),
  });
}

/** Closes a precedent's open conflict card once the precedent is settled some other way. */
export function resolvePrecedentConflict(
  ctx: WriteContext,
  projectId: ProjectId,
  id: TrustPrecedentId,
  reason: string,
): void {
  const card = findOpenByFoldKey(ctx.tx, projectId, precedentConflictFoldKey(id));
  if (card !== undefined) resolveInWrite(ctx, card, reason);
}

/**
 * The builder's answer to a conflict card, in its own write. Keep and Edit make the precedent `active` with no
 * conflicts (Edit takes the note as its new kind); Remove revokes it. A precedent that is no longer paused is left
 * as it is. Another card's answer is ignored.
 */
export function applyPrecedentConflictAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  const id = TrustPrecedentId.safeParse(item.detail?.[PRECEDENT_CONFLICT_DETAIL]);
  if (!id.success) return;
  const row = listPrecedents(ctx.tx, item.projectId).find((r) => r.id === id.data);
  if (row?.state !== PrecedentState.Paused) return;
  switch (answer.choice) {
    case PrecedentConflictChoice.Keep:
      setPrecedent(ctx, item.projectId, row.id, { state: PrecedentState.Active });
      return;
    case PrecedentConflictChoice.Edit: {
      const kind = PrecedentKind.safeParse(answer.note ?? '');
      if (!kind.success)
        throw new InvalidError('Edit needs a note saying what kind of command this is.');
      setPrecedent(ctx, item.projectId, row.id, { state: PrecedentState.Active, kind: kind.data });
      return;
    }
    case PrecedentConflictChoice.Remove:
      setPrecedent(ctx, item.projectId, row.id, { state: PrecedentState.Revoked });
      return;
    default:
      return;
  }
}

/** Says, in the caller's write, that what an approved kind runs has changed, with where to Remove or Keep it. */
export function postPrecedentChanged(
  ctx: WriteContext,
  projectId: ProjectId,
  precedent: Pick<TrustPrecedentDto, 'id' | 'programKey' | 'kind'>,
  hash: string,
): void {
  postNotice(ctx, {
    tier: CardTier.Notice,
    projectId,
    taskId: null,
    key: `precedent-changed:${precedent.id}:${hash}`,
    tone: 'warning',
    line: `What the standing approval for ${oneLine(precedent.programKey).slice(0, TITLE_KEY_MAX)} runs has changed`,
    body: `The committed text of ${quoted(precedent.kind)} is not what you approved, and the judge is told so. Remove the standing approval, or Keep it for the new text, in Settings › This Project › Trust.`,
  });
}
