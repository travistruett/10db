import {
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalDto,
  ShapeProposalState,
  ShapeRoundMark,
  type ShapeConvertedDto,
  type ShapeId,
  type ShapeTurnDto,
  type ShapeViewDto,
} from '@10db/contracts';
import {
  getDecision,
  getShape,
  listShapeFiles,
  listShapeLinks,
  listShapeMessages,
  listShapeProposals,
  type DbReader,
  type ShapeLinkRow,
  type ShapeProposalRow,
} from '@10db/db';

// Shape spec §4, §6 Rows. What the Shape screen reads: the transcript, every proposal row with its
// typed body, and what Convert made of the accepted ones.

/** The prefix of the transcript line `note_heard` writes (tools.ts), followed by the items. */
const HEARD_LINE = /^note_heard ·\s?(.*)$/s;

/** The items of the latest `note_heard` echo; it replaces the one before. */
function latestHeard(
  messages: readonly { author: string; kind: string; body: string }[],
): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.author !== ShapeMessageAuthor.Claude || m.kind !== ShapeMessageKind.Tool) continue;
    const match = HEARD_LINE.exec(m.body);
    if (match) return (match[1] ?? '').split(' · ').filter((item) => item !== '');
  }
  return [];
}

function convertedOf(
  db: DbReader,
  row: ShapeProposalRow,
  links: readonly ShapeLinkRow[],
): ShapeConvertedDto | null {
  if (row.state !== ShapeProposalState.Accepted) return null;
  const mine = links.filter((l) => l.proposalId === row.id);
  const decisionId = mine.find((l) => l.decisionId !== null)?.decisionId ?? null;
  return {
    goalId: mine.find((l) => l.goalId !== null)?.goalId ?? null,
    taskIds: mine.flatMap((l) => (l.taskId === null ? [] : [l.taskId])),
    decisionId,
    ...(decisionId === null ? {} : { withdrawn: getDecision(db, decisionId).withdrawnAt !== null }),
  };
}

/**
 * What the latest round did to a row, until the next one (§6): a row carries the round that last
 * created or changed it, or moved it to Earlier.
 */
function markOf(row: ShapeProposalRow, latestRound: number): ShapeRoundMark | null {
  if (row.round !== latestRound) return null;
  if (row.state === ShapeProposalState.Superseded) return ShapeRoundMark.Moved;
  if (row.state !== ShapeProposalState.Pending) return null;
  return row.createdRound === row.round ? ShapeRoundMark.New : ShapeRoundMark.Changed;
}

function proposalOf(
  db: DbReader,
  row: ShapeProposalRow,
  links: readonly ShapeLinkRow[],
  latestRound: number,
): ShapeProposalDto {
  // The row's body was validated when it was written; parsing it again types it for the screen.
  return ShapeProposalDto.parse({
    id: row.id,
    key: row.key,
    kind: row.kind,
    state: row.state,
    round: row.round,
    pinned: row.pinned,
    mark: markOf(row, latestRound),
    sourceMessageIds: row.sourceMessageIds,
    body: ShapeProposalBody[row.kind].parse(row.body),
    converted: convertedOf(db, row, links),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function buildShapeView(db: DbReader, shapeId: ShapeId, turn: ShapeTurnDto): ShapeViewDto {
  const messages = listShapeMessages(db, shapeId);
  const links = listShapeLinks(db, shapeId);
  const shape = getShape(db, shapeId);
  return {
    shape,
    messages,
    proposals: listShapeProposals(db, shapeId).map((row) =>
      proposalOf(db, row, links, shape.round),
    ),
    heard: latestHeard(messages),
    files: listShapeFiles(db, shapeId),
    turn,
  };
}
