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

/**
 * The one note a refused docker leaves. A refusal turns nothing on and reruns nothing: the gate runs
 * lane-written code, so the builder decides whether the project gets Docker. The note says the gate
 * asked for it and where the switch is; it has no answer the daemon acts on.
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
      'A gate ran docker and the sandbox refused it, so the gate failed. The gate asked for Docker.',
      'Docker is off for this project. It can mount any host folder into a container, so a gate or lane with Docker can reach outside the sandbox, and 10db does not turn it on because a gate asked.',
      'If this project needs it, Settings › General has the switch.',
    ].join('\n'),
    foldKey: `docker-needed:${input.project.id}`,
  });
}

/**
 * Turn it off on the note turns the project's switch off in the answer's own transaction, as the
 * builder's own setting does. Any other card, and Keep it on, is left alone.
 */
export function applyDockerChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  if (item.kind !== InboxKind.Flag || item.detail?.[DOCKER_DETAIL] !== true) return;
  if (answer.choice !== DockerChoice.TurnOff) return;
  patchProject(ctx, item.projectId, { sandboxDocker: false });
}
