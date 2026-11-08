import type { HazardRemoval, ProjectId } from '@10db/contracts';
import { applyHazardAdditions, getProject, readHazardAssessment, recordHazardRead } from '@10db/db';
import type { StateStore } from '../events';
import type { AreaNamer } from '../folders';
import type { Git } from '../git';
import type { Logger } from '../log';
import { checkAssessment, staleAdditions, type CheckInput } from './check';
import { assessmentPrompt } from './prompt';
import { readRepoText } from './repo-text';
import { setHazardRemovalCard } from './removal-card';

/** How long the model may take to answer before the look is given up and nothing changes. */
export const ASSESS_MS = 90_000;
/** How long a commit that changed a manifest waits, so a burst of commits is one look. */
export const SCHEDULE_MS = 15_000;

export type AssessOutcome =
  | {
      readonly ok: true;
      /** How many entries this look added to the hazards. */
      readonly added: number;
      /** How many changes the Inbox card now waits on the builder for. */
      readonly removals: number;
    }
  | { readonly ok: false; readonly message: string };

export interface HazardAssessor {
  /**
   * Reads the project's main checkout and saves what the repository shows: additions apply, and a
   * removal or narrowing raises the project's one Inbox card. A look already running is joined. When
   * the model is unavailable or slow nothing changes.
   */
  assess(projectId: ProjectId, signal?: AbortSignal): Promise<AssessOutcome>;
  /** Asks for a look soon, in the background; calls close together make one. */
  schedule(projectId: ProjectId): void;
  /** Cancels what is waiting to run. */
  stop(): void;
}

export interface AssessorDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'survey' | 'commitAt' | 'fileAt'>;
  /** The model question the areas use: it gets text and no tool. Null when there is no model. */
  readonly asker: AreaNamer | null;
  readonly logger: Logger;
  /** Overrides `ASSESS_MS`. */
  readonly askMs?: number;
  /** Overrides `SCHEDULE_MS`. */
  readonly scheduleMs?: number;
}

const fail = (message: string): AssessOutcome => ({ ok: false, message });

/**
 * The model's answer to `prompt`, or null when it fails or is not back within `ms`. One signal ends
 * the question when the caller gives up or the bound passes, so nothing it started keeps running.
 */
async function answer(
  asker: AreaNamer,
  prompt: string,
  ms: number,
  caller: AbortSignal | undefined,
): Promise<string | null> {
  if (caller?.aborted === true) return null;
  const question = new AbortController();
  const stop = (): void => {
    question.abort();
  };
  const timer = setTimeout(stop, ms);
  caller?.addEventListener('abort', stop, { once: true });
  const ended = new Promise<null>((resolve) => {
    question.signal.addEventListener(
      'abort',
      () => {
        resolve(null);
      },
      { once: true },
    );
  });
  try {
    const asked = asker(prompt, question.signal);
    // An asker that ignores its signal still must not hold the look past the bound.
    asked.catch(() => undefined);
    return await Promise.race([asked, ended]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', stop);
    question.abort();
  }
}

const same = (a: HazardRemoval, b: HazardRemoval): boolean =>
  a.hazard === b.hazard && a.kind === b.kind && a.value === b.value;

export function createHazardAssessor(deps: AssessorDeps): HazardAssessor {
  const running = new Map<ProjectId, Promise<AssessOutcome>>();
  const waiting = new Map<ProjectId, ReturnType<typeof setTimeout>>();

  async function look(
    projectId: ProjectId,
    signal: AbortSignal | undefined,
  ): Promise<AssessOutcome> {
    if (deps.asker === null) return fail('There is no model to read the project with.');
    const project = getProject(deps.state.db, projectId);
    const text = await readRepoText(deps.git, project.repoPath);
    if (text === null) return fail("10db couldn't read this project's files.");
    const recorded = readHazardAssessment(deps.state.db, projectId);
    const input: CheckInput = {
      tracked: text.tracked,
      lines: new Map(text.files.map((f) => [f.path, f.lines])),
      hazards: project.hazards,
      areaNames: project.areas.map((a) => a.name),
      gateCommands: [project.gateCommand, project.precheckCommand].filter(
        (c): c is string => c !== null,
      ),
      kept: recorded.kept,
    };
    const reply = await answer(
      deps.asker,
      assessmentPrompt({
        text,
        hazards: project.hazards,
        areaNames: input.areaNames,
        gateCommands: input.gateCommands,
      }),
      deps.askMs ?? ASSESS_MS,
      signal,
    );
    if (reply === null) return fail('The model was not available in time, so nothing changed.');
    const checked = checkAssessment(reply, input);
    if (checked === null) return fail("The model's answer could not be used, so nothing changed.");
    // Evidence 10db found earlier that the repository no longer shows is proposed for removal too.
    const removals = [...checked.removals];
    for (const stale of staleAdditions(recorded.additions, input)) {
      if (!removals.some((r) => same(r, stale))) removals.push(stale);
    }
    // One write: the additions apply, the read is recorded and the card says exactly what is left to ask.
    const added = deps.state.write((ctx) => {
      const applied = applyHazardAdditions(ctx, projectId, checked.additions);
      recordHazardRead(ctx, projectId, text.commit);
      setHazardRemovalCard(ctx, getProject(ctx.tx, projectId), removals);
      return applied.length;
    });
    return { ok: true, added, removals: removals.length };
  }

  function assess(projectId: ProjectId, signal?: AbortSignal): Promise<AssessOutcome> {
    const joined = running.get(projectId);
    if (joined !== undefined) return joined;
    const started = look(projectId, signal)
      .catch((error: unknown): AssessOutcome => {
        deps.logger.warn(
          { projectId, err: error instanceof Error ? error.message : String(error) },
          'hazards not assessed',
        );
        return fail("10db couldn't assess this project's hazards, so nothing changed.");
      })
      .finally(() => {
        running.delete(projectId);
      });
    running.set(projectId, started);
    return started;
  }

  return {
    assess,
    schedule(projectId) {
      const pending = waiting.get(projectId);
      if (pending !== undefined) clearTimeout(pending);
      waiting.set(
        projectId,
        setTimeout(() => {
          waiting.delete(projectId);
          void assess(projectId).then((outcome) => {
            if (outcome.ok)
              deps.logger.info({ projectId, added: outcome.added }, 'hazards assessed');
          });
        }, deps.scheduleMs ?? SCHEDULE_MS),
      );
    },
    stop() {
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
    },
  };
}
