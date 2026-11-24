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
} from '@10db/contracts';
import {
  getAccountRow,
  getInboxItem,
  getProject,
  listAccountModels,
  type DbReader,
} from '@10db/db';
import { capStatus, unready } from '../accounts';
import type { Clock } from '../clock';
import type { Launcher } from '../environment';
import { chooseModel } from '../routing';
import { CODEX_NO_QUESTIONS, CompletionError, type AgentAdapter } from '../sessions';
import {
  acceptWritten,
  answerPrompt,
  questionContext,
  type AnswerWriter,
  type WrittenAnswer,
} from '../stakeholders';
import { routingInputs } from '../team';

/** How long the model has to answer before the question goes to the builder instead. */
const ANSWER_TIMEOUT_MS = 60_000;

export interface AnswerWriterDeps {
  readonly adapter: Pick<AgentAdapter, 'complete'>;
  readonly launcher: Pick<Launcher, 'session'>;
  readonly db: DbReader;
  readonly clock: Pick<Clock, 'now'>;
  /** Whether the account is paused (a usage limit, its monthly cap or a refusal). */
  readonly paused: (accountId: AccountId) => boolean;
  /** Where each question gets its own empty folder to start in. */
  readonly scratchRoot: string;
}

const declined = (
  reason: Extract<WrittenAnswer, { kind: 'declined' }>['reason'],
): WrittenAnswer => ({
  kind: 'declined',
  reason,
});

/**
 * Writes an answer to a stakeholder's question with a model of the card's project's account, at its Efficient
 * tier and low effort, and never the default account: the project's account is the builder's billing line. The
 * model starts in a new empty folder and gets the card's context as text, so no project file is read or run.
 * A Codex account is declined until the tool-locked turn serves it. Every failure is a decline; it never throws.
 */
export function createAnswerWriter(deps: AnswerWriterDeps): AnswerWriter {
  return async ({ cardId, question, askerName, signal }) => {
    let cwd: string | null = null;
    try {
      const card = getInboxItem(deps.db, cardId);
      const project = getProject(deps.db, card.projectId);
      const account = getAccountRow(deps.db, project.accountId);
      const overCap = ((): boolean => {
        const cap = capStatus(deps.db, account, deps.clock.now());
        return cap !== null && cap.spentUsd >= cap.capUsd;
      })();
      if (unready(account) !== null || deps.paused(account.id) || overCap)
        return declined('no_account');
      if (harnessOf(account) === Provider.Codex) return declined('provider');
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
      if (isModelTier(choice.model)) return declined('no_account');
      const launch = deps.launcher.session(
        account,
        choice.model,
        listAccountModels(deps.db, account.id),
      );
      cwd = await mkdtemp(join(deps.scratchRoot, 'answer-'));
      const raw = await deps.adapter.complete({
        cwd,
        prompt: answerPrompt(questionContext(deps.db, cardId), question, askerName),
        model: launch.model,
        env: launch.env,
        account: launch.expect,
        effort: Effort.Low,
        timeoutMs: ANSWER_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      return acceptWritten(raw);
    } catch (error) {
      if (error instanceof CompletionError && error.message === CODEX_NO_QUESTIONS)
        return declined('provider');
      return declined('failed');
    } finally {
      if (cwd !== null) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
