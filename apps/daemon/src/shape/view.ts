import {
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalDto,
  ShapeProposalKind,
  ShapeProposalState,
  ShapeRoundMark,
  type ShapeCeremonyDto,
  type ShapeConvertedDto,
  type ShapeFileDto,
  type ShapeFindingDto,
  type ShapeId,
  type ShapeTaskSizeDto,
  type ShapeTurnDto,
  type ShapeViewDto,
} from '@10db/contracts';
import {
  getDecision,
  getShape,
  listRehearsals,
  listShapeAttachments,
  listShapeFiles,
  listShapeFindings,
  listShapeLinks,
  listShapeMessages,
  listShapeProposals,
  shapeTokens,
  type DbReader,
  type ShapeFileRow,
  type ShapeFindingRow,
  type ShapeLinkRow,
  type ShapeProposalRow,
} from '@10db/db';
import { ceremonyFor, type EffortFacts } from './ceremony';
import { attachmentsOf } from './attach';
import { buildPreview } from './preview';
import { rehearsalTasks } from './review';
import { buildSizes } from './sizing';

// Shape spec §4, §6 Rows. What the Shape screen reads: the transcript, every proposal row with its
// typed body, and what Convert made of the accepted ones.

/** A dropped file as the screen sees it; whether Claude has been told of it stays in the daemon. */
export function fileDtoOf(row: ShapeFileRow): ShapeFileDto {
  return {
    id: row.id,
    shapeId: row.shapeId,
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    storedPath: row.storedPath,
    createdAt: row.createdAt,
  };
}

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

/** What the view reads about the project that the rows don't hold. */
export interface ViewWorld {
  /** The areas and hazards that hold a tracked file matching a one-way path (§7). */
  readonly oneWayNames: ReadonlySet<string>;
}

const NO_WORLD: ViewWorld = { oneWayNames: new Set() };

/** Each pending goal's, loose task's and addition's ceremony: what the rule forces, and what applies. */
export function ceremonies(
  db: DbReader,
  shapeId: ShapeId,
  sizes: readonly ShapeTaskSizeDto[],
  world: ViewWorld,
): ShapeCeremonyDto[] {
  const specs = new Map(
    listShapeAttachments(db, shapeId)
      .filter((a) => a.kind === 'spec')
      .map((a) => [a.key, a.body]),
  );
  return listShapeProposals(db, shapeId).flatMap((row): ShapeCeremonyDto[] => {
    if (row.state !== ShapeProposalState.Pending) return [];
    const mine = sizes.filter((s) => s.proposalId === row.id);
    let facts: EffortFacts;
    if (row.kind === ShapeProposalKind.Goal) {
      const goal = ShapeProposalBody.goal.parse(row.body);
      facts = {
        kind: 'goal',
        claude: goal.ceremony,
        pinnedCeremony: row.pinned.includes('ceremony'),
        size: undefined,
        hours: mine.reduce((sum, s) => sum + s.hours, 0),
        taskCount: goal.tasks.length,
        taskAreas: goal.tasks.map((t) => t.areas),
      };
    } else if (row.kind === ShapeProposalKind.Task) {
      const task = ShapeProposalBody.task.parse(row.body);
      facts = {
        kind: 'task',
        claude: task.ceremony,
        pinnedCeremony: row.pinned.includes('ceremony'),
        size: mine[0]?.size,
        hours: mine[0]?.hours ?? 0,
        taskCount: 1,
        taskAreas: [task.areas],
      };
    } else return [];
    const verdict = ceremonyFor(facts, world.oneWayNames);
    const spec = specs.get(row.key) ?? null;
    return [
      {
        proposalId: row.id,
        key: row.key,
        ceremony: verdict.ceremony,
        reasons: verdict.reasons,
        skippedByYou: verdict.skippedByYou,
        specWritten: spec !== null,
        spec,
      },
    ];
  });
}

const findingOf = (row: ShapeFindingRow): ShapeFindingDto => ({
  id: row.id,
  shapeId: row.shapeId,
  effortKey: row.effortKey,
  taskKey: row.taskKey,
  reviewer: row.reviewer,
  kind: row.kind,
  severity: row.severity,
  text: row.text,
  state: row.state,
  how: row.how,
  round: row.round,
  taskHash: row.taskHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function buildShapeView(
  db: DbReader,
  shapeId: ShapeId,
  turn: ShapeTurnDto,
  world: ViewWorld = NO_WORLD,
  now: Date = new Date(),
): ShapeViewDto {
  const messages = listShapeMessages(db, shapeId);
  const links = listShapeLinks(db, shapeId);
  const shape = getShape(db, shapeId);
  const sizes = buildSizes(db, shapeId);
  const marked = new Set(listRehearsals(db, shapeId).map((m) => `${m.taskKey}\0${m.hash}`));
  return {
    shape,
    messages,
    proposals: listShapeProposals(db, shapeId).map((row) =>
      proposalOf(db, row, links, shape.round),
    ),
    heard: latestHeard(messages),
    files: listShapeFiles(db, shapeId).map(fileDtoOf),
    turn,
    sizes,
    ceremony: ceremonies(db, shapeId, sizes, world),
    findings: listShapeFindings(db, shapeId).map(findingOf),
    rehearsals: rehearsalTasks(db, shapeId).map((t) => ({
      proposalId: t.proposalId,
      key: t.taskKey,
      hash: t.hash,
      rehearsed: marked.has(`${t.taskKey}\0${t.hash}`),
    })),
    preview: buildPreview(db, shapeId, now),
    attachments: attachmentsOf(db, shapeId),
    tokens: shapeTokens(db, shapeId),
  };
}
