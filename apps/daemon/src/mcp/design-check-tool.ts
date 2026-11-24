import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AreaRole,
  CheckDesignInput,
  CHECK_DESIGN_DESCRIPTION,
  CHECK_DESIGN_TOOL,
  DesignCheckPurpose,
  InvalidError,
  WorkspaceMode,
  type ApprovedMockup,
  type DesignCheckShot,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getProject,
  getTask,
  getWorkstream,
  insertDesignChecks,
  latestTaskDesignChecks,
  passHoldingTask,
  setDesignCheckVerdict,
  type DbReader,
} from '@10db/db';
import { imagesWithinBudget } from '../conversation';
import type { StateStore } from '../events';
import { checkShotsOf, missingLines, type Pictures } from '../pictures';
import { approvedMockupsOf } from '../plan-record';
import { lanePicturesSpent, sessionPictureLimits } from './picture-spend';
import { ToolImages } from './tool-images';

// Plan-in-sessions spec §4, "Design review": a lane whose task has an approved mock-up is offered
// `check_design`, which shoots the task's page now and answers it beside the mock-up drawn to a picture.
// The pictures are the tool's result, so a lane reads none of the data directory's files. They count
// against the picture limits of the lane's account, as every picture a session is sent does: a session
// resumed past its request limit would fail every later turn.

export interface DesignCheckDeps {
  readonly state: StateStore;
  readonly pictures: Pick<Pictures, 'shootNow' | 'drawMockup' | 'bytesOf'>;
  /** The lane's session, whose account's picture limits apply. */
  readonly sessionId: SessionId;
}

/** Whether the lane's task has an approved mock-up, so `check_design` is offered to it. */
export function offersDesignCheck(db: DbReader, workstreamId: WorkstreamId): boolean {
  return approvedMockupsOf(db, getWorkstream(db, workstreamId).taskId).length > 0;
}

/** What the tool says to a task that runs in a separate copy, where 10db serves no app. */
const WORKTREE_TASK =
  "This task runs in a worktree, where 10db serves no app, so there is nothing to shoot. Compare by reading the approved mock-up's HTML in your brief against the code you wrote, and say in your handoff what still differs.";
const NO_PAGE =
  'This task names no page area with a route, so there is no page to shoot. Compare by reading the mock-up in your brief.';

/** The tool as the lane endpoint registers it. */
export function checkDesignTool(
  deps: DesignCheckDeps,
  workstreamId: WorkstreamId,
): {
  readonly name: string;
  readonly description: string;
  readonly schema: typeof CheckDesignInput;
  run(input: CheckDesignInput): Promise<ToolImages | { readonly recorded: true } | string>;
} {
  const db = deps.state.db;
  return {
    name: CHECK_DESIGN_TOOL,
    description: CHECK_DESIGN_DESCRIPTION,
    schema: CheckDesignInput,
    async run(input) {
      const { taskId } = getWorkstream(db, workstreamId);
      if (input.verdict !== undefined) {
        const latest = latestTaskDesignChecks(db, taskId);
        if (latest.length === 0)
          throw new InvalidError('Call check_design first, then record what you saw.');
        const verdict = input.verdict;
        deps.state.write((ctx) => {
          for (const check of latest) setDesignCheckVerdict(ctx, check.id, verdict);
        });
        return { recorded: true };
      }
      const task = getTask(db, taskId);
      const project = getProject(db, task.projectId);
      const mockups = approvedMockupsOf(db, taskId);
      if (mockups.length === 0) throw new InvalidError('This task has no approved mock-up.');
      const routes = [
        ...new Set(
          project.areas.flatMap((a) =>
            a.role === AreaRole.Page && a.route !== undefined && task.areas.includes(a.name)
              ? [a.route]
              : [],
          ),
        ),
      ];
      const designPath = join(project.repoPath, 'DESIGN.md');
      const designMd = existsSync(designPath) ? designPath : null;
      /** Keeps this call's checks, one per mock-up, in one write, with `shotsOf` for each. */
      const keep = (
        shotsOf: DesignCheckShot[],
        drawn: Map<ApprovedMockup, string | null>,
      ): void => {
        deps.state.write((ctx) =>
          insertDesignChecks(
            ctx,
            mockups.map((mockup) => ({
              projectId: project.id,
              shapeId: null,
              taskId,
              attachmentId: mockup.id,
              purpose: DesignCheckPurpose.LaneCheck,
              mockupSha256: drawn.get(mockup) ?? null,
              shots: shotsOf,
              designMdPath: designMd,
            })),
          ),
        );
      };
      // A call that shoots nothing is kept as well, so a verdict after it has a check to sit on.
      const unshot = (reason: string): string => {
        keep(
          routes.map((route) => ({
            route,
            viewport: project.screens.viewports[0] ?? { width: 1440, height: 900 },
            theme: project.screens.themes[0] ?? 'default',
            sha256: null,
            missing: reason,
          })),
          new Map(),
        );
        return reason;
      };
      if (task.workspaceMode !== WorkspaceMode.Shared && passHoldingTask(db, task) === undefined)
        return unshot(WORKTREE_TASK);
      if (routes.length === 0) return unshot(NO_PAGE);

      const limits = sessionPictureLimits(db, deps.sessionId);
      // What earlier calls sent: the task's checks, and the lane screens its conversation carries.
      const spent = lanePicturesSpent(db, deps.pictures.bytesOf, taskId, deps.sessionId);

      const taken = await deps.pictures.shootNow({
        projectId: project.id,
        routes,
        purpose: DesignCheckPurpose.LaneCheck,
      });
      const drawn = new Map<ApprovedMockup, string | null>();
      const candidates: { label: string; path: string; bytes: number }[] = [];
      const text: string[] = [
        `DESIGN.md: ${designMd ?? 'none; this project has no DESIGN.md at its root'}`,
      ];
      for (const mockup of mockups) {
        const made = await deps.pictures.drawMockup(project.id, mockup.html);
        drawn.set(mockup, 'sha256' in made ? made.sha256 : null);
        if ('path' in made)
          candidates.push({
            label: `mock-up ${mockup.key}, drawn`,
            path: made.path,
            bytes: deps.pictures.bytesOf(made.sha256),
          });
        else
          text.push(
            `Mock-up ${mockup.key}: no picture (${made.missing}); read its HTML in your brief.`,
          );
      }
      for (const shot of taken.shots)
        candidates.push({
          label: `${shot.route} as the app shows it now`,
          path: shot.path,
          bytes: deps.pictures.bytesOf(shot.sha256),
        });
      keep(checkShotsOf(routes, taken), drawn);

      // What fits goes, in order; the rest is counted, so a resumed session never passes its request limit.
      const fits = imagesWithinBudget(
        candidates.map((c) => c.bytes),
        spent,
        limits,
      );
      const images: { mediaType: string; data: string }[] = [];
      for (const index of fits) {
        const c = candidates[index];
        if (c === undefined) continue;
        images.push({ mediaType: 'image/png', data: readFileSync(c.path).toString('base64') });
        text.push(`Image ${String(images.length)}: ${c.label}.`);
      }
      const leftOut = candidates.length - fits.length;
      if (leftOut > 0)
        text.push(
          images.length === 0
            ? `The picture budget for this session is used up: ${String(leftOut)} PNG${leftOut === 1 ? '' : 's'} left out. Compare by reading the mock-up's HTML in your brief.`
            : `${String(leftOut)} PNG${leftOut === 1 ? '' : 's'} left out to keep this session within its picture budget; compare those by the mock-up's HTML in your brief.`,
        );
      text.push(...missingLines(routes, taken));
      text.push(
        'Compare the mock-up with the app and fix what differs, then call check_design again with `verdict`: what still differs, or that nothing does.',
      );
      return new ToolImages(text.join('\n'), images);
    },
  };
}
