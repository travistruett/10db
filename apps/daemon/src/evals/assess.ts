import {
  EvalAssessmentState,
  EvalManifest,
  EventType,
  type AccountId,
  type EvalAssessmentDto,
  type ProjectId,
} from '@10db/contracts';
import { getProject } from '@10db/db';
import type { StateStore } from '../events';
import { askWithin, modelJson, type AreaNamer } from '../folders';
import type { Git } from '../git';
import type { Logger } from '../log';
import { CompletionError } from '../sessions';
import { evalAssessmentPrompt, type AssessFile } from './assess-prompt';
import { STOCK_CALL_PATTERNS, findCallSites } from './call-sites';
import { findEvalMarkers } from './markers';
import { findEvalSkills } from './new-eval-task';
import type { EvalsService } from './service';

/** How long the model may take to answer before the look is given up and nothing changes. */
export const ASSESS_MS = 120_000;
/** How long a commit that changed an eval file waits, so a burst of commits is one assessment. */
export const SCHEDULE_MS = 20_000;

/** The most files and the most text the model is given, and the bounds of one file. */
const MAX_FILES = 60;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_TOTAL_BYTES = 300_000;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 240;
const MAX_CALL_SITE_LINES = 150;

export type EvalAssessOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly unavailable: boolean; readonly message: string };

export interface EvalsAssessor {
  /** Reads the project's evals at HEAD and records what the model makes of them. A run in progress is joined. */
  assess(projectId: ProjectId, signal?: AbortSignal): Promise<EvalAssessOutcome>;
  /** Where the project's assessment stands, for the page. */
  status(projectId: ProjectId): EvalAssessmentDto;
  /** Asks for an assessment soon, in the background; calls close together make one. */
  schedule(projectId: ProjectId): void;
  /** Cancels what is waiting to run. */
  stop(): void;
}

export interface EvalsAssessorDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'survey' | 'commitAt' | 'surveyTexts' | 'grepAt'>;
  readonly evals: Pick<EvalsService, 'record'>;
  /** The model question the areas use: it gets text and no tool. Null when there is no model. */
  readonly asker: AreaNamer | null;
  readonly logger: Logger;
  /** Overrides `ASSESS_MS`. */
  readonly askMs?: number;
  /** Overrides `SCHEDULE_MS`. */
  readonly scheduleMs?: number;
}

const refuse = (message: string, unavailable = false): EvalAssessOutcome => ({
  ok: false,
  unavailable,
  message,
});

const cut = (line: string): string =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;

/** The paths the model reads, most telling first: eval definitions and skills, then code that calls a model. */
async function pickFiles(
  git: EvalsAssessorDeps['git'],
  repoPath: string,
  commit: string,
  tracked: readonly string[],
): Promise<{
  files: AssessFile[];
  definitions: string[];
  callSites: string[];
} | null> {
  const markers = findEvalMarkers(tracked);
  const skills = await findEvalSkills(git, repoPath, new Set(tracked));
  const sites = await findCallSites(git, repoPath, commit, STOCK_CALL_PATTERNS).catch(() => null);
  const siteLines = (sites?.sites ?? [])
    .slice(0, MAX_CALL_SITE_LINES)
    .map((s) => `${s.path}:${String(s.line)}`);
  const prompts = [...markers.promptCases.values()].flat();
  const rootDocs = tracked.filter((p) =>
    /^(?:AGENTS\.md|Makefile|package\.json|README\.md)$/u.test(p),
  );
  const wanted = [
    ...new Set([
      ...skills.flatMap((s) => s.paths),
      ...markers.definitions,
      ...prompts,
      ...rootDocs,
      ...(sites?.sites ?? []).map((s) => s.path),
    ]),
  ].slice(0, MAX_FILES);
  const read = await git.surveyTexts(repoPath, wanted, {
    maxBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  });
  if (read.refused !== null) return null;
  const files = wanted.flatMap((path): AssessFile[] => {
    const text = read.texts.get(path);
    if (text === undefined) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return [{ path, lines: lines.slice(0, MAX_LINES).map(cut) }];
  });
  return { files, definitions: [...markers.definitions], callSites: siteLines };
}

/**
 * Assesses a project's evals on its own: a model of the project's account reads the eval files and the code that
 * calls a model, as text with no tool, and answers an `EvalManifest`. `EvalsService.record` is the gate, so a
 * path the repository doesn't track records nothing. A model that is absent, slow or unusable changes nothing.
 */
export function createEvalsAssessor(deps: EvalsAssessorDeps): EvalsAssessor {
  const running = new Map<ProjectId, Promise<EvalAssessOutcome>>();
  const waiting = new Map<ProjectId, ReturnType<typeof setTimeout>>();
  /** Aborted by `stop`, so an assessment in flight ends and touches nothing the daemon is closing. */
  const closing = new AbortController();
  const lastFailure = new Map<ProjectId, { unavailable: boolean; message: string }>();

  const changed = (projectId: ProjectId): void => {
    // The Evals view refetches on the project's change, as it does when a manifest is recorded.
    deps.state.write((ctx) => {
      ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: projectId });
    });
  };

  async function look(
    projectId: ProjectId,
    signal: AbortSignal | undefined,
  ): Promise<EvalAssessOutcome> {
    if (deps.asker === null) return refuse('There is no model to read the project with.', true);
    const project = getProject(deps.state.db, projectId);
    if (project.archivedAt) return refuse('This project is archived.');
    const survey = await deps.git.survey(project.repoPath, 0);
    if ('refused' in survey || survey.files.length === 0) {
      return refuse("10db couldn't read this project's files.");
    }
    const commit = await deps.git.commitAt(project.repoPath, 'HEAD');
    const picked = await pickFiles(deps.git, project.repoPath, commit, survey.files);
    if (picked === null) return refuse("10db couldn't read this project's files.");
    let asked: unknown = null;
    const asker = deps.asker;
    const capture: AreaNamer = async (prompt, signal2, accountId?: AccountId) => {
      try {
        return await asker(prompt, signal2, accountId);
      } catch (error) {
        asked = error;
        throw error;
      }
    };
    const reply = await askWithin(
      capture,
      evalAssessmentPrompt({
        files: picked.files,
        patterns: STOCK_CALL_PATTERNS,
        definitions: picked.definitions,
        callSites: picked.callSites,
      }),
      deps.askMs ?? ASSESS_MS,
      signal,
      project.accountId,
    );
    if (asked instanceof CompletionError) {
      return refuse(asked.message, true);
    }
    if (reply === null) return refuse('The model was not available in time, so nothing changed.');
    const parsed = EvalManifest.safeParse(modelJson(reply));
    if (!parsed.success) return refuse("The model's answer could not be used, so nothing changed.");
    if (parsed.data.suites.length === 0 && parsed.data.gaps.length === 0) {
      return refuse('The assessment found no evals and no model calls it could use.');
    }
    const recorded = await deps.evals.record(projectId, project.repoPath, parsed.data);
    if (!recorded.ok) return refuse(recorded.message);
    return { ok: true };
  }

  function assess(projectId: ProjectId, signal?: AbortSignal): Promise<EvalAssessOutcome> {
    const joined = running.get(projectId);
    if (joined !== undefined) return joined;
    lastFailure.delete(projectId);
    const started = look(
      projectId,
      signal === undefined ? closing.signal : AbortSignal.any([signal, closing.signal]),
    )
      .catch((error: unknown): EvalAssessOutcome => {
        if (closing.signal.aborted) return refuse('The daemon is stopping.');
        deps.logger.warn(
          { projectId, err: error instanceof Error ? error.message : String(error) },
          'evals not assessed',
        );
        return refuse("10db couldn't assess this project's evals, so nothing changed.");
      })
      .then((outcome) => {
        running.delete(projectId);
        if (!outcome.ok && !closing.signal.aborted) {
          lastFailure.set(projectId, {
            unavailable: outcome.unavailable,
            message: outcome.message,
          });
          changed(projectId);
        }
        return outcome;
      });
    running.set(projectId, started);
    changed(projectId);
    return started;
  }

  return {
    assess,
    status(projectId) {
      if (running.has(projectId)) return { state: EvalAssessmentState.Assessing, reason: null };
      const failed = lastFailure.get(projectId);
      if (failed === undefined) return { state: EvalAssessmentState.Idle, reason: null };
      return {
        state: failed.unavailable ? EvalAssessmentState.Unavailable : EvalAssessmentState.Failed,
        reason: failed.message,
      };
    },
    schedule(projectId) {
      const pending = waiting.get(projectId);
      if (pending !== undefined) clearTimeout(pending);
      waiting.set(
        projectId,
        setTimeout(() => {
          waiting.delete(projectId);
          void assess(projectId);
        }, deps.scheduleMs ?? SCHEDULE_MS),
      );
    },
    stop() {
      closing.abort();
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
    },
  };
}
