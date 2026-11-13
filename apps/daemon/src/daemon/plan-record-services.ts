import type { PlanExportInput, PlanImportInput, ProjectId, ShapeId } from '@10db/contracts';
import { getProject, getShape, listProjects } from '@10db/db';
import type { PlanImportOutcome, PlanRecordServices } from '../api';
import type { StateStore } from '../events';
import {
  exportPlan,
  importBundle,
  inlineBundle,
  loadStoredRecord,
  planImportChanges,
  readBundleFile,
  validateBundle,
} from '../plan-record';

// One service behind both doors to a Plan's record: the HTTP route and the builder's `import_plan`.

export function createPlanRecordServices(deps: {
  readonly state: StateStore;
  /** 10db's data dir, which a bundle may not be read from and an export may not write into. */
  readonly dataDir: string;
  /** Where worktrees are made, and the sandbox's roots: neither is read from or written into. */
  readonly worktreeRoot: string;
  readonly sandboxRoots: readonly string[];
}): PlanRecordServices {
  return {
    async exportPlan(shapeId: ShapeId, input: PlanExportInput) {
      getShape(deps.state.db, shapeId);
      return await exportPlan(
        {
          shapeId,
          dir: input.dir,
          forbidden: {
            checkouts: listProjects(deps.state.db).map((p) => p.repoPath),
            worktreeRoot: deps.worktreeRoot,
            dataDir: deps.dataDir,
            sandboxRoots: deps.sandboxRoots,
          },
        },
        deps.state.db,
      );
    },
    async importPlan(projectId: ProjectId, input: PlanImportInput): Promise<PlanImportOutcome> {
      const read =
        'bundlePath' in input
          ? await readBundleFile(input.bundlePath, deps)
          : inlineBundle(input.bundle);
      if (!read.ok) return { kind: 'refused', errors: read.errors };
      const { bundle, bodies } = read;
      // Checking, planning and writing share one transaction, so what was checked is what is written.
      return deps.state.write((ctx): PlanImportOutcome => {
        const project = getProject(ctx.tx, projectId);
        const stored = loadStoredRecord(ctx.tx, projectId, bundle.id);
        const errors = validateBundle({
          bundle,
          bodies,
          projectId,
          areaNames: new Set([
            ...project.areas.map((a) => a.name),
            ...project.hazards.map((h) => h.name),
          ]),
          stored,
        });
        if (errors.length > 0) return { kind: 'refused', errors };
        const changes = planImportChanges(stored, bundle, bodies);
        if (input.dryRun)
          return {
            kind: 'previewed',
            preview: {
              dryRun: true,
              shapeId: stored?.shapeId ?? null,
              title: bundle.title,
              changes,
            },
          };
        return {
          kind: 'imported',
          result: importBundle(ctx, { projectId, bundle, bodies, changes }),
        };
      });
    },
  };
}
