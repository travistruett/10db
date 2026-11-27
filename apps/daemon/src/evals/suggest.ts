import {
  evalGapPath,
  harnessOf,
  Provider,
  type EvalSuggestRequest,
  type EvalSuggestResult,
  type EvalSuggestStatusDto,
  type ProjectId,
} from '@10db/contracts';
import { defaultAccountId, getAccountRow, getProject, type DbReader } from '@10db/db';
import { askWithin, type AreaNamer } from '../folders';
import type { Git } from '../git';
import type { Logger } from '../log';
import { CODEX_NO_QUESTIONS, CompletionError, NO_DEFAULT_ACCOUNT } from '../sessions';
import type { AssessFile } from './assess-prompt';
import { parseSuggestAnswer } from './suggest-answer';
import { evalSuggestPrompt } from './suggest-prompt';

/** How long the model may take to answer one wizard question. */
export const SUGGEST_MS = 60_000;

/** The code a suggestion reads: a few files at HEAD, short ones, so a question stays cheap. */
const MAX_FILES = 4;
const MAX_FILE_BYTES = 24 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_LINES = 200;
const MAX_LINE_CHARS = 200;

export interface EvalSuggester {
  /** Whether the project has a model to ask, so the wizard can hide its buttons and say why. */
  status(projectId: ProjectId): EvalSuggestStatusDto;
  /** Asks the project's model one question; never throws for a model that is absent or slow. */
  suggest(
    projectId: ProjectId,
    request: EvalSuggestRequest,
    signal?: AbortSignal,
  ): Promise<EvalSuggestResult>;
}

export interface EvalSuggesterDeps {
  readonly db: DbReader;
  readonly git: Pick<Git, 'surveyTexts'>;
  /** The model question the areas use: it gets text and no tool. Null when there is no model. */
  readonly asker: AreaNamer | null;
  readonly logger: Logger;
  /** Overrides `SUGGEST_MS`. */
  readonly askMs?: number;
}

const NONE_YET =
  'Suggestions need a model 10db can ask, and this project has none yet. Everything else works: fill each step in yourself.';
const CODEX_ONLY =
  "Suggestions aren't available on this project's account yet (a Codex account doesn't answer 10db's one-shot questions). Everything else works: fill each step in yourself.";

const refuse = (message: string, unavailable: boolean): EvalSuggestResult => ({
  ok: false,
  unavailable,
  message,
});

const cut = (line: string): string =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;

/**
 * Answers the New Eval wizard's suggest buttons: one question to a model of the project's account (the
 * assessment's way of asking: text in, no tool, the efficient tier) with the files the gap names read at HEAD.
 * The answer is parsed and shown for the builder to accept; nothing is recorded.
 */
export function createEvalSuggester(deps: EvalSuggesterDeps): EvalSuggester {
  const status = (projectId: ProjectId): EvalSuggestStatusDto => {
    if (deps.asker === null) return { available: false, reason: NONE_YET };
    const own = getProject(deps.db, projectId).accountId;
    // A Codex account answers no one-shot question, so the default account is asked in its place.
    if (harnessOf(getAccountRow(deps.db, own)) !== Provider.Codex)
      return { available: true, reason: null };
    const fallback = defaultAccountId(deps.db);
    if (fallback === null || harnessOf(getAccountRow(deps.db, fallback)) === Provider.Codex)
      return { available: false, reason: CODEX_ONLY };
    return { available: true, reason: null };
  };

  async function readFiles(repoPath: string, where: readonly string[]): Promise<AssessFile[]> {
    const wanted = [...new Set(where.map(evalGapPath))].slice(0, MAX_FILES);
    if (wanted.length === 0) return [];
    const read = await deps.git.surveyTexts(repoPath, wanted, {
      maxBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    });
    return wanted.flatMap((path): AssessFile[] => {
      const text = read.texts.get(path);
      if (text === undefined) return [];
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return [{ path, lines: lines.slice(0, MAX_LINES).map(cut) }];
    });
  }

  return {
    status,
    async suggest(projectId, request, signal) {
      const asker = deps.asker;
      if (asker === null) return refuse(NONE_YET, true);
      const project = getProject(deps.db, projectId);
      let failure: unknown = null;
      const capture: AreaNamer = async (prompt, signal2, accountId) => {
        try {
          return await asker(prompt, signal2, accountId);
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      try {
        const files = await readFiles(project.repoPath, request.where).catch(() => []);
        const reply = await askWithin(
          capture,
          evalSuggestPrompt(request, files),
          deps.askMs ?? SUGGEST_MS,
          signal,
          project.accountId,
        );
        if (failure instanceof CompletionError) {
          if (failure.message === CODEX_NO_QUESTIONS) return refuse(CODEX_ONLY, true);
          if (failure.message === NO_DEFAULT_ACCOUNT) return refuse(NONE_YET, true);
          return refuse(failure.message, false);
        }
        if (reply === null) return refuse('The model was not available in time. Try again.', false);
        const parsed = parseSuggestAnswer(request.kind, reply);
        return parsed.ok ? { ok: true, answer: parsed.answer } : refuse(parsed.reason, false);
      } catch (error) {
        deps.logger.warn(
          { projectId, err: error instanceof Error ? error.message : String(error) },
          'eval suggestion failed',
        );
        return refuse("10db couldn't get a suggestion. Try again.", false);
      }
    },
  };
}
