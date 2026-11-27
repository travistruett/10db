import type { EvalCandidateDto, EvalSuiteKey, ProjectId } from '@10db/contracts';
import {
  getProject,
  listAccountModels,
  listAccounts,
  listModelProfiles,
  type DbReader,
} from '@10db/db';
import { buildModelRows, type CatalogueSync } from '../catalogue';
import type { Clock } from '../clock';
import { buildCandidates, type EvalsService } from '../evals';

export interface EvalCandidateListDeps {
  readonly db: DbReader;
  readonly evals: Pick<EvalsService, 'candidateBasis'>;
  readonly catalogue: Pick<CatalogueSync, 'catalogue'>;
  readonly clock: Clock;
}

/**
 * The models a suite may try with their prices, intelligence, estimates and last results here: what the
 * candidates route answers, and what a `cheapest` sweep sorts its steps by. None for a suite with no `live.models`.
 */
export function createEvalCandidateList(
  deps: EvalCandidateListDeps,
): (projectId: ProjectId, suiteKey: EvalSuiteKey) => Promise<EvalCandidateDto[]> {
  return async (projectId, suiteKey) => {
    const basis = await deps.evals.candidateBasis(
      projectId,
      getProject(deps.db, projectId).repoPath,
      suiteKey,
    );
    if (basis.models === null) return [];
    const catalogue = deps.catalogue.catalogue();
    const rows = buildModelRows({
      profiles: listModelProfiles(deps.db),
      offers: listAccountModels(deps.db),
      accounts: listAccounts(deps.db),
      catalogue,
      now: deps.clock.now(),
    });
    return buildCandidates({
      models: basis.models,
      catalogue,
      intelligence: new Map(rows.map((r) => [r.model, r.intelligence])),
      runs: basis.runs,
    });
  };
}
