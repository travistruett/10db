import { InboxKind, type InboxAnswer, type InboxItemDto, type ProjectId } from '@10db/contracts';
import { patchProject, type WriteContext } from '@10db/db';
import type { InboxService } from './service';

const DOCKER_DETAIL = 'dockerAuto';

/** The answers the note offers; the card shows them as written. */
export const DockerChoice = {
  Keep: 'Keep it on',
  TurnOff: 'Turn it off',
} as const;
export type DockerChoice = (typeof DockerChoice)[keyof typeof DockerChoice];

/**
 * Why 10db turned Docker on: only what the committed base branch shows. A docker call a gate ran
 * and the sandbox refused is not a reason, because lane-written code can make one.
 */
export const DockerWhy = {
  /** The gate command or its Makefile target was seen to call docker. */
  Called: 'called',
} as const;
export type DockerWhy = (typeof DockerWhy)[keyof typeof DockerWhy];

const REASON: Readonly<Record<DockerWhy, string>> = {
  [DockerWhy.Called]:
    "The project's gate command (or the Makefile target or script it runs) calls docker, which a sandboxed gate can't run without it.",
};

/**
 * The one note 10db leaves when it turns a project's Docker switch on by itself: what it did and why,
 * with the warning the switch carries and an answer that turns it off again. It folds into the
 * project's open note, so a project gets one, and answering Turn it off records the builder's
 * choice, which 10db's own turning on never overrides (`projects.sandbox_docker_opt_out`).
 */
export function raiseDockerOnNote(
  deps: { readonly inbox: InboxService },
  input: {
    readonly project: { readonly id: ProjectId; readonly name: string };
    readonly why: DockerWhy;
  },
): InboxItemDto {
  return deps.inbox.flag({
    projectId: input.project.id,
    workstreamId: null,
    title: `Docker is on for ${input.project.name}'s gate and lanes`,
    body: [
      REASON[input.why],
      'Docker can mount any host folder into a container, so a gate or lane with Docker can reach outside the sandbox.',
      'Settings › General has the switch; if you turn it off, 10db will not turn it on again.',
    ].join('\n'),
    options: [
      {
        label: DockerChoice.Keep,
        description: 'The gate and every lane in this project can use docker compose',
      },
      {
        label: DockerChoice.TurnOff,
        description: 'Gates and lanes get the Docker refusal again; 10db does not turn it back on',
      },
    ],
    recommendation: DockerChoice.Keep,
    detail: { [DOCKER_DETAIL]: true },
    foldKey: `docker-on:${input.project.id}`,
  });
}

const DOCKER_NEEDED_DETAIL = 'dockerNeeded';

/** The answers the note a refused docker leaves offers; the card shows them as written. */
export const DockerNeededChoice = {
  TurnOn: 'Turn Docker on',
  KeepOff: 'Keep it off',
} as const;
export type DockerNeededChoice = (typeof DockerNeededChoice)[keyof typeof DockerNeededChoice];

/** The fold key of a project's note that a gate asked for Docker; one per project, ever. */
export function dockerNeededFoldKey(projectId: ProjectId): string {
  return `docker-needed:${projectId}`;
}

/**
 * The one note a refused docker leaves. A refusal turns nothing on and reruns nothing: the gate runs
 * lane-written code, so the builder decides whether the project gets Docker. Both answers are that
 * decision, made in Settings' terms: Turn Docker on sets the switch, Keep it off records the
 * builder's opt-out, so the note is not raised again (`auto-docker.ts` also raises none once one was
 * answered).
 */
export function raiseDockerMayBeNeededNote(
  deps: { readonly inbox: InboxService },
  input: { readonly project: { readonly id: ProjectId; readonly name: string } },
): InboxItemDto {
  return deps.inbox.flag({
    projectId: input.project.id,
    workstreamId: null,
    title: `${input.project.name} may need Docker`,
    body: [
      'A gate ran docker, which the sandbox refused, and the gate failed. The gate asked for Docker.',
      'Docker is off for this project. It can mount any host folder into a container, so a gate or lane with Docker can reach outside the sandbox, and 10db does not turn it on because a gate asked.',
      'Settings › General has the switch, or answer here.',
    ].join('\n'),
    options: [
      {
        label: DockerNeededChoice.TurnOn,
        description: 'The gate and every lane in this project can use docker compose',
      },
      {
        label: DockerNeededChoice.KeepOff,
        description:
          'Gates and lanes keep the Docker refusal; 10db does not turn it on or ask again',
      },
    ],
    recommendation: null,
    detail: { [DOCKER_NEEDED_DETAIL]: true },
    foldKey: dockerNeededFoldKey(input.project.id),
  });
}

/**
 * An answer on either Docker note sets the project's switch in the answer's own transaction, as the
 * builder's own setting does: Turn it off and Keep it off turn it off as a choice 10db keeps, Turn
 * Docker on turns it on. Any other card, and Keep it on, is left alone.
 */
export function applyDockerChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  if (item.kind !== InboxKind.Flag) return;
  if (item.detail?.[DOCKER_DETAIL] === true) {
    if (answer.choice === DockerChoice.TurnOff)
      patchProject(ctx, item.projectId, { sandboxDocker: false });
    return;
  }
  if (item.detail?.[DOCKER_NEEDED_DETAIL] !== true) return;
  if (answer.choice === DockerNeededChoice.TurnOn)
    patchProject(ctx, item.projectId, { sandboxDocker: true });
  else if (answer.choice === DockerNeededChoice.KeepOff)
    patchProject(ctx, item.projectId, { sandboxDocker: false });
}
