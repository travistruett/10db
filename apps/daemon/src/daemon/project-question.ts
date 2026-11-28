import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Effort,
  harnessOf,
  isModelTier,
  ModelTier,
  Provider,
  StepRole,
  type AccountId,
  type ProjectId,
} from '@10db/contracts';
import { getAccountRow, getProject, listAccountModels, type DbReader } from '@10db/db';
import { capStatus, unready } from '../accounts';
import type { Clock } from '../clock';
import type { Launcher } from '../environment';
import { chooseModel } from '../routing';
import { completeWithCodex, type AgentAdapter, type CodexCompleteOptions } from '../sessions';
import { routingInputs } from '../team';

export interface ProjectQuestionDeps {
  readonly adapter: Pick<AgentAdapter, 'complete'>;
  readonly launcher: Pick<Launcher, 'session'>;
  readonly db: DbReader;
  readonly clock: Pick<Clock, 'now'>;
  /** Whether the account is paused (a usage limit, its monthly cap or a refusal). */
  readonly paused: (accountId: AccountId) => boolean;
  /** Where each question gets its own empty folder to start in. */
  readonly scratchRoot: string;
  /** What a Codex account's tool-locked turn runs on; null while the pinned Codex copy isn't ready. */
  readonly codex: () => CodexCompleteOptions | null;
}

/** One question asked of a project's account, with no tool, in a new empty folder. */
export type ProjectQuestion =
  | {
      readonly kind: 'ready';
      /** The model the question runs on, as the account launches it. */
      readonly model: string;
      /** Asks once and answers the model's text; rejects on a timeout, a withdrawal or a failed start. */
      readonly ask: (
        prompt: string,
        opts: { readonly signal?: AbortSignal; readonly timeoutMs: number },
      ) => Promise<string>;
    }
  | { readonly kind: 'declined'; readonly reason: 'no_account' | 'failed' };

/**
 * Prepares a question on the project's own account, at its Efficient tier and low effort, and never the default
 * account: the project's account is the builder's billing line. An unready, paused or over-cap account is
 * `no_account`; a Codex account while the pinned Codex copy isn't ready is `failed`. A Codex account's turn is the
 * tool-locked `completeWithCodex`. Throws only what reading the project or account throws.
 */
export function prepareProjectQuestion(
  deps: ProjectQuestionDeps,
  projectId: ProjectId,
): ProjectQuestion {
  const project = getProject(deps.db, projectId);
  const account = getAccountRow(deps.db, project.accountId);
  const cap = capStatus(deps.db, account, deps.clock.now());
  const overCap = cap !== null && cap.spentUsd >= cap.capUsd;
  if (unready(account) !== null || deps.paused(account.id) || overCap)
    return { kind: 'declined', reason: 'no_account' };
  const onCodex = harnessOf(account) === Provider.Codex;
  const codex = onCodex ? deps.codex() : null;
  if (onCodex && codex === null) return { kind: 'declined', reason: 'failed' };
  const choice = chooseModel({
    ...routingInputs(deps.db, project),
    def: { role: StepRole.Plan, need: 0 },
    requirements: [{ kind: 'automatic' }],
    effort: Effort.Low,
    fallback: null,
    pinned: false,
    task: { modelSetting: { kind: 'tier', tier: ModelTier.Efficient }, effortPin: Effort.Low },
    project,
    byScore: false,
  });
  if (isModelTier(choice.model)) return { kind: 'declined', reason: 'no_account' };
  const launch = deps.launcher.session(
    account,
    choice.model,
    listAccountModels(deps.db, account.id),
  );
  return {
    kind: 'ready',
    model: launch.model,
    ask: async (prompt, { signal, timeoutMs }) => {
      const cwd = await mkdtemp(join(deps.scratchRoot, 'question-'));
      try {
        const completion = {
          cwd,
          prompt,
          model: launch.model,
          env: launch.env,
          account: launch.expect,
          effort: Effort.Low,
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        };
        return codex === null
          ? await deps.adapter.complete(completion)
          : await completeWithCodex(completion, codex);
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
