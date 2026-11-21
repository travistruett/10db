import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AreaRole,
  CheckDesignInput,
  CHECK_DESIGN_DESCRIPTION,
  CHECK_DESIGN_TOOL,
  DesignCheckPurpose,
  InvalidError,
  SCREEN_IMAGE_MAX_BYTES,
  WorkspaceMode,
} from '@10db/contracts';
import {
  getProject,
  getTask,
  getWorkstream,
  insertDesignCheck,
  latestTaskDesignCheck,
  passHoldingTask,
  setDesignCheckVerdict,
  type DbReader,
} from '@10db/db';
import type { WorkstreamId } from '@10db/contracts';
import { existsSync } from 'node:fs';
import type { StateStore } from '../events';
import { checkShotsOf, missingLines, type Pictures } from '../pictures';
import { approvedMockupsOf } from '../plan-record';
import { ToolImages } from './tool-images';

// Plan-in-sessions spec §4, "Design review": a lane whose task has an approved mock-up is offered
// `check_design`, which shoots the task's page now and answers it beside the mock-up drawn to a picture.
// The pictures are the tool's result, so a lane reads none of the data directory's files.

export interface DesignCheckDeps {
  readonly state: StateStore;
  readonly pictures: Pick<Pictures, 'shootNow' | 'drawMockup'>;
}

/** Whether the lane's task has an approved mock-up, so `check_design` is offered to it. */
export function offersDesignCheck(db: DbReader, workstreamId: WorkstreamId): boolean {
  return approvedMockupsOf(db, getWorkstream(db, workstreamId).taskId).length > 0;
}

/** What the tool says to a task that runs in a separate copy, where 10db serves no app. */
const WORKTREE_TASK =
  "This task runs in a worktree, where 10db serves no app, so there is nothing to shoot. Compare by reading the approved mock-up's HTML in your brief against the code you wrote, and say in your handoff what still differs.";

const image = (path: string): { mediaType: string; data: string } | null => {
  const bytes = readFileSync(path);
  return bytes.length > SCREEN_IMAGE_MAX_BYTES
    ? null
    : { mediaType: 'image/png', data: bytes.toString('base64') };
};

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
        const latest = latestTaskDesignCheck(db, taskId);
        if (latest === null)
          throw new InvalidError('Call check_design first, then record what you saw.');
        const verdict = input.verdict;
        deps.state.write((ctx) => setDesignCheckVerdict(ctx, latest.id, verdict));
        return { recorded: true };
      }
      const task = getTask(db, taskId);
      const project = getProject(db, task.projectId);
      const mockups = approvedMockupsOf(db, taskId);
      if (mockups.length === 0) throw new InvalidError('This task has no approved mock-up.');
      if (task.workspaceMode !== WorkspaceMode.Shared && passHoldingTask(db, task) === undefined)
        return WORKTREE_TASK;
      const routes = [
        ...new Set(
          project.areas.flatMap((a) =>
            a.role === AreaRole.Page && a.route !== undefined && task.areas.includes(a.name)
              ? [a.route]
              : [],
          ),
        ),
      ];
      if (routes.length === 0)
        return 'This task names no page area with a route, so there is no page to shoot. Compare by reading the mock-up in your brief.';
      const taken = await deps.pictures.shootNow({
        projectId: project.id,
        routes,
        purpose: DesignCheckPurpose.LaneCheck,
      });
      const designPath = join(project.repoPath, 'DESIGN.md');
      const designMd = existsSync(designPath) ? designPath : null;
      const text: string[] = [
        `DESIGN.md: ${designMd ?? 'none; this project has no DESIGN.md at its root'}`,
      ];
      const images: { mediaType: string; data: string }[] = [];
      for (const mockup of mockups) {
        const drawn = await deps.pictures.drawMockup(project.id, mockup.html);
        deps.state.write((ctx) =>
          insertDesignCheck(ctx, {
            projectId: project.id,
            shapeId: null,
            taskId,
            attachmentId: mockup.id,
            purpose: DesignCheckPurpose.LaneCheck,
            mockupSha256: 'sha256' in drawn ? drawn.sha256 : null,
            shots: checkShotsOf(routes, taken),
            designMdPath: designMd,
          }),
        );
        const drawnImage = 'path' in drawn ? image(drawn.path) : null;
        if (drawnImage === null)
          text.push(
            `Mock-up ${mockup.key}: no picture (${'missing' in drawn ? drawn.missing : 'too large'}); read its HTML in your brief.`,
          );
        else {
          images.push(drawnImage);
          text.push(`Image ${String(images.length)}: mock-up ${mockup.key}, drawn.`);
        }
      }
      for (const shot of taken.shots) {
        const shown = image(shot.path);
        if (shown === null) text.push(`${shot.route} now: the picture is too large to send.`);
        else {
          images.push(shown);
          text.push(`Image ${String(images.length)}: ${shot.route} as the app shows it now.`);
        }
      }
      text.push(...missingLines(routes, taken));
      text.push(
        'Compare the mock-up with the app and fix what differs, then call check_design again with `verdict`: what still differs, or that nothing does.',
      );
      return new ToolImages(text.join('\n'), images);
    },
  };
}
