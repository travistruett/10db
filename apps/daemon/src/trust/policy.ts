import {
  COPY_ID_VARIABLE,
  type CopyId,
  SkipKind,
  TrustPolicy,
  TrustSurface,
  type ProjectDto,
  type TrustSwitches,
} from '@10db/contracts';
import { coordinationLines } from './coordination';
import type { ComposeServices } from '../folders';
import { LIMIT_ORDER, LIMITS } from './limits';
import { quotedValue } from './quoted-value';
import { approvedLine, type ApprovedAction } from './skip';

export interface TrustPolicyInput {
  readonly surface: TrustSurface;
  readonly projectName: string;
  readonly checkout: string;
  readonly gateCommand: string | null;
  readonly liveSystems: readonly string[];
  readonly switches: TrustSwitches;
  /** The calls the builder approved by Run these now for this session's task; none when absent. */
  readonly approved?: readonly ApprovedAction[];
  /** The project's grants as lines (`projectGrantLines`), read as the session starts. */
  readonly grants: readonly string[];
  /** What the builder wrote on this run when they retried it or sent it back (`builderNotesOf`); none when absent. */
  readonly builderNotes?: readonly string[];
  /** The names of the builder's own MCP servers in this session; their tools act outside the sandbox. */
  readonly yourMcpServers: readonly string[];
  /** Whether the session carries the builder's claude.ai connectors, which act outside the sandbox. */
  readonly claudeConnectors: boolean;
  readonly devAccess: DevAccess;
  /** The separate copy the session runs in; absent or null outside one. */
  readonly copyId?: CopyId | null;
  /**
   * The standing approvals the session can be shown (`precedentLines`), for Claude's auto mode as context only.
   * They go into `autoModePrecedents` and nowhere else: not `allow`, which auto mode reads as an exception to a
   * soft deny, and not `environment`, which 10db's judge copies into the state of every call.
   */
  readonly precedents?: readonly string[];
}

/** What of this Mac's dev environment is open to the session (`sessionDevAccess`). */
export interface DevAccess {
  /** The session's commands may reach this Mac's Docker engine. */
  readonly docker: boolean;
  /** The session's commands may reach loopback addresses. */
  readonly localhost: boolean;
  /** The project's compose services, read from its committed base; null when Docker is closed or none. */
  readonly compose: ComposeServices | null;
}

/**
 * Whether Docker and loopback are open to a session, by the rule its sandbox is built on: the engine's socket
 * only for a session that may write, loopback by the project's switch alone. A session with no sandbox runs no
 * command, and a lane step that only reads has every docker command refused by the guard, so both are closed.
 */
export function sessionDevAccess(
  project: Pick<ProjectDto, 'sandboxDocker' | 'sandboxLoopback'>,
  session: { readonly sandboxed: boolean; readonly writes: boolean },
): Pick<DevAccess, 'docker' | 'localhost'> {
  return {
    docker: session.sandboxed && session.writes && project.sandboxDocker,
    localhost: session.sandboxed && project.sandboxLoopback,
  };
}

/** The lines that tell the judge what Docker, the project's compose services and loopback are to it. */
function devAccessLines(access: DevAccess): string[] {
  const lines = [
    access.docker
      ? "Docker: open to this session. It may run docker and docker compose against this Mac's Docker engine. Containers run outside the macOS sandbox, so a command run in one is judged by what it can reach, as if the session ran it."
      : 'Docker: closed to this session; 10db refuses docker and docker compose in it.',
  ];
  const compose = access.docker ? access.compose : null;
  if (compose !== null) {
    const project = compose.project === null ? null : quotedValue(compose.project);
    const named =
      compose.project === null
        ? 'usually named <project>-<service>-<n>, the project being the folder compose runs in'
        : `usually named <project>-<service>-<n>, such as ${quotedValue(`${compose.project}-${compose.services[0] ?? ''}-1`)}`;
    const containers =
      compose.containerNames.length === 0
        ? ''
        : `, or by their container_name ${compose.containerNames.map(quotedValue).join(', ')}`;
    lines.push(
      `Local dev containers: the compose services ${compose.services.map(quotedValue).join(', ')}${project === null ? '' : ` of the compose project ${project}`}, from ${compose.files.map(quotedValue).join(', ')} at the project's base. Their containers are ${named}${containers}. They are this project's local dev environment on this Mac, and their own processes are not live systems. A container that forwards to a remote system (a cloud-sql-proxy, a kubectl port-forward, an ssh -L tunnel, a service proxying to a hosted database or API) is that system: judge what it forwards to, not that it runs here.`,
      "Routine in them: running a command in one of these containers (docker exec, docker compose exec or run), or in docker run --rm with only this checkout or this session's temp folder mounted, crosses no limit by itself. Listing and reading the project's source there, and running its tests, linters, formatters, type checks, builds and file generators, such as making migration files or an API client that land in the checkout, are routine. What the command does is still judged under the four limits, as if the session ran it: reading a .env file, a key or a credential there is reading secrets, and reaching a host outside this Mac is judged by what it sends or writes there.",
    );
  }
  if (access.docker || access.localhost)
    lines.push(
      "Still a limit on this Mac: a local database, in a container or on a loopback port, may be shared by this project's sessions and hold data this session didn't create. Dropping or truncating a table, deleting or updating rows, applying migrations to it (migrate), resetting or re-seeding it, docker compose down -v and docker volume rm destroy data.",
    );
  lines.push(
    access.localhost
      ? "Localhost: open to this session. Loopback addresses (localhost, 127.0.0.1, a dev server, a container's published port) are this Mac, unless something there forwards to a remote system (a cloud-sql-proxy, a kubectl port-forward, an ssh -L tunnel, a container proxying to a hosted service): that is judged as the remote system."
      : 'Localhost: closed to this session; its commands reach no loopback address.',
  );
  return lines;
}

/**
 * What a separate copy owns, for a session that runs in one: none outside a copy. The project's own commands
 * scope to the copy by its id, as the separate-copy spec asks of them, so what they do to the copy's databases and stack
 * destroys nothing others have; a command that names anything else is still judged as shared.
 */
function copyLines(copyId: CopyId | null): string[] {
  if (copyId === null) return [];
  const id = quotedValue(copyId);
  return [
    `Separate copy: this session runs in a separate copy of the project, with its own folder (the checkout above), its own branch and its own databases; every command it runs gets ${COPY_ID_VARIABLE}=${id}. The project's own commands (its make targets, scripts and copy wrappers) read that id and act on the copy's own databases and dev stack: the databases, compose projects, containers and volumes whose names hold ${id}, created on first use and removed by 10db's teardown when the copy is retired. Running the project's checks, tests, migrations and generators through them, preparing or resetting the copy's databases, and taking the copy's stack down with its volumes destroy nothing others have. Those commands load the project's dev config themselves, so running one is not reading a secret unless it prints or sends a value. Everything else on this Mac stays shared and is judged as shared: a command that names another database, volume or compose project, a docker compose down -v or docker volume rm without the copy's own name (compose names a project after its folder, and the copy's folders have the same names as the builder's), and anything that reaches the builder's folder.`,
  ];
}

/** Whether a person is in the session: a lane runs alone; a pass, Plan and chat have the builder in them. */
export function isAttended(surface: TrustSurface): boolean {
  switch (surface) {
    case TrustSurface.Lane:
      return false;
    case TrustSurface.Pass:
    case TrustSurface.Plan:
    case TrustSurface.Chat:
      return true;
  }
}

/** Whether the session works in its checkout (a lane, a pass) or only reads it (Plan, chat). */
function works(surface: TrustSurface): boolean {
  return surface === TrustSurface.Lane || surface === TrustSurface.Pass;
}

/**
 * The environment the judge reads the limits in. Every value 10db didn't write is a quoted value, so a
 * project name, a path or a live system cannot end a line or read as one of 10db's sentences.
 */
function environmentLines(input: TrustPolicyInput): string[] {
  const checkout = quotedValue(input.checkout);
  return [
    `Organization: one builder working alone on their own Mac, with 10db running agent sessions for the project ${quotedValue(input.projectName)}.`,
    input.surface === TrustSurface.Chat
      ? `Host containment: a macOS sandbox. This session reads ${checkout}, writes in it only while its turn holds the folder, and writes nothing else outside its own temp folder; other folders and credentials are closed to it.`
      : works(input.surface)
        ? `Host containment: a macOS sandbox. This session writes only in ${checkout} and its own temp folder, and the commands it runs reach only the project's allowed network hosts; other folders, other sessions' copies and credentials are closed to it.`
        : `Host containment: a macOS sandbox. This session reads ${checkout} and writes nothing outside its own temp folder.`,
    ...(works(input.surface)
      ? [
          "Trusted repo: files tracked in this checkout are the session's to change; git keeps them, so deleting or rewriting them is not destroying data. Untracked or ignored files, files outside the checkout, databases and history others have are.",
        ]
      : []),
    ...devAccessLines(input.devAccess),
    ...copyLines(input.copyId ?? null),
    ...(input.yourMcpServers.length > 0
      ? [
          `Outside the sandbox: the MCP servers ${input.yourMcpServers.join(', ')} are the builder's own and run with the builder's access. Their tools can read and change anything the builder can, so judge each call to them under the four limits and the coordination rules above, as if the session made it directly.`,
        ]
      : []),
    ...(input.claudeConnectors
      ? [
          "Outside the sandbox: the claude.ai connectors are the builder's own and run with the builder's access. They can read and send the builder's mail, documents and messages, so judge each call to them under the four limits and the coordination rules above, as if the session made it directly.",
        ]
      : []),
    ...(input.liveSystems.length > 0
      ? [
          `Sensitive remote targets: ${input.liveSystems.map(quotedValue).join(', ')}. These are live: treat a write to any of them as writing to a live system.`,
        ]
      : []),
  ];
}

/** The builder's notes on the run as allow lines Claude Code's auto mode reads, each on one line. */
function builderNoteLines(notes: readonly string[]): string[] {
  return notes.map(
    (note) => `The builder wrote on this run: ${JSON.stringify(note.replace(/\s+/g, ' ').trim())}`,
  );
}

/** The approved calls a judge reads by intent, as lines: only the classifier's, which it skipped by intent. */
export function approvedLines(approved: readonly ApprovedAction[]): string[] {
  return approved.flatMap((a) => {
    if (a.kind !== SkipKind.Classifier) return [];
    const line = approvedLine(a);
    return line === null ? [] : [line];
  });
}

/** One session's policy, for every judge alike (trust line §3). */
export function buildTrustPolicy(input: TrustPolicyInput): TrustPolicy {
  return TrustPolicy.parse({
    surface: input.surface,
    attended: isAttended(input.surface),
    limits: LIMIT_ORDER.map((name) => ({ name, ...LIMITS[name] })),
    environment: environmentLines(input),
    coordination: coordinationLines(input.surface, input.gateCommand),
    // Only the classifier reads by intent; the guard and the broker match the other approvals' keys.
    allow: [
      ...new Set([
        ...approvedLines(input.approved ?? []),
        ...input.grants,
        ...builderNoteLines(input.builderNotes ?? []),
      ]),
    ],
    autoModePrecedents: input.precedents ?? [],
    switches: input.switches,
  });
}
