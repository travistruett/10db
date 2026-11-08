import type { ProjectDto } from '@10db/contracts';
import { autoEnableDocker, getProject } from '@10db/db';
import type { StateStore } from '../events';
import { DockerWhy, raiseDockerOnNote, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { GateRequest, GateRunner } from '../verify';
import { callsDocker } from './docker-need';

export interface AutoDockerDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly logger: Logger;
  /**
   * The text of a repository file as the project's base branch commits it, or null when absent. Never
   * the working tree: a lane writes that, and a lane's edit must not be what turns Docker on.
   */
  readonly readBase: (repoPath: string, ref: string, path: string) => Promise<string | null>;
}

/**
 * Gives every project's gate its Docker switch as it stands now, and turns the switch on when the
 * project needs it, unless the builder turned it off:
 *
 * - the gate command, or the Makefile target or script it runs in the base branch, is seen to call
 *   docker (`callsDocker`): the switch goes on before the gate runs;
 * - the gate failed and the sandbox refused a `docker` it ran: the switch goes on and the gate runs
 *   once more, on the tree it just tested, and its result is the one answered.
 *
 * Each turning on leaves the project's one Inbox note (`raiseDockerOnNote`). A gate that names no
 * project (an install, a generator) runs as it was asked.
 */
export function autoDocker(inner: GateRunner, deps: AutoDockerDeps): GateRunner {
  /** Turns the switch on and says so; false when it was on already or the builder turned it off. */
  function turnOn(project: ProjectDto, why: DockerWhy): boolean {
    const enabled = deps.state.write((ctx) => autoEnableDocker(ctx, project.id));
    if (enabled === null) return false;
    deps.logger.info({ projectId: project.id, why }, 'turned Docker on for a project');
    raiseDockerOnNote(deps, { project: { id: project.id, name: project.name }, why });
    return true;
  }

  async function seenToCallDocker(project: ProjectDto, command: string): Promise<boolean> {
    // Reads the base the project's PRs land in: tried as origin's branch, then the local one.
    const read = async (path: string): Promise<string | null> => {
      for (const ref of [`origin/${project.baseBranch}`, project.baseBranch]) {
        try {
          const text = await deps.readBase(project.repoPath, ref, path);
          if (text !== null) return text;
        } catch {
          // This ref isn't there; the next may be.
        }
      }
      return null;
    };
    try {
      return await callsDocker(command, read);
    } catch (error) {
      deps.logger.warn(
        { projectId: project.id, err: error instanceof Error ? error.message : String(error) },
        'could not tell whether the gate calls docker',
      );
      return false;
    }
  }

  const withSwitch = (request: GateRequest, sandboxDocker: boolean): GateRequest => ({
    ...request,
    project: { ...request.project, sandboxDocker },
  });

  return {
    async run(request) {
      const id = request.project.id;
      if (id === undefined) return inner.run(request);
      let project: ProjectDto;
      try {
        project = getProject(deps.state.db, id);
      } catch {
        return inner.run(request);
      }
      let on = project.sandboxDocker;
      // Free to turn on: the builder has not turned it off, and nothing has yet.
      if (!on && !project.sandboxDockerOptOut && (await seenToCallDocker(project, request.command)))
        on = turnOn(project, DockerWhy.Called);
      const result = await inner.run(withSwitch(request, on));
      if (on || result.exitCode === 0 || result.timedOut || result.aborted) return result;
      if (result.dockerRefused !== true || !turnOn(project, DockerWhy.Refused)) return result;
      deps.logger.info({ projectId: id }, 'the gate failed on a refused docker; running it again');
      // The tree is the one the first run tested: no base update, no second gate-started event.
      return inner.run({
        ...withSwitch(request, true),
        beforeStart: () => Promise.resolve(request.signal?.aborted !== true),
        onStarted: () => undefined,
      });
    },
  };
}
