import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AreaRole,
  DesignCheckPurpose,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type AreaDef,
  type ProjectDto,
  type ShapeId,
  type ShapeProposalId,
} from '@10db/contracts';
import {
  insertDesignCheck,
  insertShapeMessage,
  listShapeAttachments,
  type DbReader,
  type ShapeAttachmentRow,
} from '@10db/db';
import type { StateStore } from '../events';
import { checkShotsOf, missingLines, type Pictures } from '../pictures';
import { designReviewNote, type DesignReviewTask } from './policy';
import { rehearsalTasks, type RehearsalTask } from './review';

// Plan-in-sessions spec §4, "Design review": for each pending task that has a mock-up and a page area,
// the mock-up is drawn to a picture and the page is shot as it is now, and the review turn is told where
// the pictures lie. The turn is queued only once the pictures are taken.

/** One task a Design review reads: its mock-up, and the routes of its page areas. */
export interface DesignTarget {
  readonly task: RehearsalTask;
  readonly mockup: ShapeAttachmentRow;
  readonly routes: readonly string[];
}

/** The page areas' routes a task names, each once. */
function pageRoutesOf(
  areas: readonly Pick<AreaDef, 'name' | 'role' | 'route'>[],
  taskAreas: readonly string[],
): string[] {
  return [
    ...new Set(
      areas.flatMap((a) =>
        a.role === AreaRole.Page && a.route !== undefined && taskAreas.includes(a.name)
          ? [a.route]
          : [],
      ),
    ),
  ];
}

/**
 * The pending tasks a Design review reads: each with a mock-up (the approved one, else the newest) and at
 * least one page area with a route; narrowed to some proposals when the builder chose them.
 */
export function designTargets(
  db: DbReader,
  shapeId: ShapeId,
  areas: readonly Pick<AreaDef, 'name' | 'role' | 'route'>[],
  proposalIds?: readonly ShapeProposalId[],
): DesignTarget[] {
  const mockups = listShapeAttachments(db, shapeId).filter((a) => a.kind === 'mockup');
  return rehearsalTasks(db, shapeId)
    .filter((t) => proposalIds === undefined || proposalIds.includes(t.proposalId))
    .flatMap((task) => {
      const routes = pageRoutesOf(areas, task.areas);
      const mine = mockups.filter((a) => a.key === task.taskKey);
      const mockup =
        mine.find((a) => a.approvedAt !== null) ??
        [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return routes.length === 0 || mockup === undefined ? [] : [{ task, mockup, routes }];
    });
}

/** The project's `DESIGN.md` as its checkout holds it at the root, or null when it has none. */
export function designMdPath(project: Pick<ProjectDto, 'repoPath'>): string | null {
  const path = join(project.repoPath, 'DESIGN.md');
  return existsSync(path) ? path : null;
}

export interface DesignReviewDeps {
  readonly state: StateStore;
  readonly pictures: Pick<Pictures, 'shootNow' | 'drawMockup'>;
  /** The plan's folder, which the session and its reviewers read. */
  readonly planFilesDir: (shapeId: ShapeId) => string;
}

/** Copies a picture into the plan's folder, which a session reads, and answers its path there. */
function intoPlanFolder(dir: string, sha256: string, from: string): string {
  const folder = join(dir, 'design');
  mkdirSync(folder, { recursive: true });
  const to = join(folder, `${sha256}.png`);
  if (!existsSync(to)) copyFileSync(from, to);
  return to;
}

/**
 * Takes the pictures for each target, keeps one design check per task, and queues the review note with
 * where the pictures are. The page's shots are taken once for every route the targets share.
 */
export async function runDesignReview(
  deps: DesignReviewDeps,
  shapeId: ShapeId,
  project: ProjectDto,
  targets: readonly DesignTarget[],
  say: (line: string) => void,
): Promise<void> {
  const routes = [...new Set(targets.flatMap((t) => t.routes))];
  const taken = await deps.pictures.shootNow({
    projectId: project.id,
    routes,
    purpose: DesignCheckPurpose.PlanReview,
    say,
  });
  const dir = deps.planFilesDir(shapeId);
  const designMd = designMdPath(project);
  const read: DesignReviewTask[] = [];
  for (const target of targets) {
    const drawn = await deps.pictures.drawMockup(project.id, target.mockup.body);
    const shots = checkShotsOf(target.routes, taken);
    deps.state.write((ctx) =>
      insertDesignCheck(ctx, {
        projectId: project.id,
        shapeId,
        taskId: null,
        attachmentId: target.mockup.id,
        purpose: DesignCheckPurpose.PlanReview,
        mockupSha256: 'sha256' in drawn ? drawn.sha256 : null,
        shots,
        designMdPath: designMd,
      }),
    );
    read.push({
      effortKey: target.task.effortKey,
      taskKey: target.task.taskKey,
      text: target.task.text,
      mockup: 'sha256' in drawn ? intoPlanFolder(dir, drawn.sha256, drawn.path) : null,
      shots: taken.shots
        .filter((s) => target.routes.includes(s.route))
        .map((s) => ({ route: s.route, path: intoPlanFolder(dir, s.sha256, s.path) })),
      missing: [
        ...('missing' in drawn ? [`the mock-up could not be drawn: ${drawn.missing}`] : []),
        ...missingLines(target.routes, taken),
      ],
    });
  }
  const { note, instruction, inSession } = designReviewNote(read, designMd);
  deps.state.write((ctx) =>
    insertShapeMessage(ctx, shapeId, {
      author: ShapeMessageAuthor.Note,
      kind: ShapeMessageKind.DesignReview,
      body: note,
      prompt: instruction,
      promptInSession: inSession,
    }),
  );
}
