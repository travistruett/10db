import { Provider, type SupportedAccountKind, type Effort, type ProjectDto } from '@10db/contracts';
import type { TakeoverLaunch } from '../environment';
import {
  claudeTakeoverMcp,
  codexTakeoverServers,
  setupPromptText,
  tomlString,
  type AgentAdapter,
  type SessionMcpServer,
  type YourSessionServer,
} from '../sessions';
import { writeTakeoverFile } from './files';
import { renderTakeover } from './render';
import { unlinkSync } from 'node:fs';

// Sessions spec §7.5: one set of files for one launch of the builder's terminal: the servers the chat's session
// had, its instructions, the agent's command and the script that runs it. A set is never read back, since the
// terminal's agent can write the folder; every launch makes a fresh one.

/** What the chat's session ran with, resolved from its project's account and its conversation. */
export interface TakeoverSource {
  readonly cwd: string;
  readonly kind: SupportedAccountKind;
  /** The harness the account runs. */
  readonly harness: Provider;
  /** The model as the agent is launched with it. */
  readonly model: string;
  readonly effort: Effort;
  readonly launch: TakeoverLaunch;
  /** Whether the project's Web switch is on. */
  readonly web: boolean;
}

/** What the chat's session had of the builder's setup and servers, launched into the takeover folder. */
export interface TakeoverServers {
  readonly instructions: string | null;
  readonly pluginDirs: readonly string[];
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  readonly yourMcpServers: Readonly<Record<string, YourSessionServer>>;
  /** What was left out, in words for the builder. */
  readonly notes: readonly string[];
  /** The temp dirs the servers' sandboxes use, for the startup sweep to leave alone. */
  readonly tempDirs: readonly string[];
  /** Removes the servers' sandboxes and sealed files. */
  remove(): void;
}

export interface PrepareDeps {
  readonly adapter: Pick<AgentAdapter, 'takeoverCommand' | 'takeoverNotes'>;
  /** Launches the servers and the setup for the chat's project into `folder`. */
  servers(project: ProjectDto, folder: string, source: TakeoverSource): Promise<TakeoverServers>;
  /** Marks the agent's own first-run screens done for the folder, as the account needs. */
  onboard(source: TakeoverSource): Promise<void>;
  /** A short name for one set's files. */
  newSetId(): string;
}

export interface PreparedTakeover {
  /** The script Terminal and iTerm open. */
  readonly script: string;
  /** The same command as one line to paste. */
  readonly line: string;
  readonly notes: readonly string[];
  readonly tempDirs: readonly string[];
  /** Removes this set's servers and files; the folder and other sets stay. */
  remove(): void;
}

export interface PrepareInput {
  readonly project: ProjectDto;
  readonly source: TakeoverSource;
  readonly providerSessionId: string;
  /** The takeover folder, made already. */
  readonly folder: string;
}

/** Writes one set of files for the chat's terminal. Any throw leaves nothing of the set behind. */
export async function prepareTakeover(
  deps: PrepareDeps,
  input: PrepareInput,
  signal: AbortSignal,
): Promise<PreparedTakeover> {
  const { source, folder } = input;
  signal.throwIfAborted();
  await deps.onboard(source);
  signal.throwIfAborted();
  const servers = await deps.servers(input.project, folder, source);
  const written: string[] = [];
  const remove = (): void => {
    for (const file of written.splice(0)) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone, or the agent replaced it: the folder's removal takes what is left.
      }
    }
    servers.remove();
  };
  try {
    signal.throwIfAborted();
    const id = deps.newSetId();
    const write = (name: string, extension: string, content: string, mode: number): string => {
      const path = writeTakeoverFile(folder, `${name}-${id}.${extension}`, content, mode);
      written.push(path);
      return path;
    };
    const codex = source.harness === Provider.Codex;
    const notes = [
      ...deps.adapter.takeoverNotes({ kind: source.kind, harness: source.harness }),
      ...servers.notes,
    ];
    let mcpConfigFile: string | null = null;
    let sealedEnvFile: string | null = null;
    let codexServers: ReturnType<typeof codexTakeoverServers>['servers'] = [];
    if (codex) {
      const mapped = codexTakeoverServers(servers);
      codexServers = mapped.servers;
      if (mapped.sealed.length > 0)
        sealedEnvFile = write('sealed', 'sh', `${mapped.sealed.join('\n')}\n`, 0o600);
      if (mapped.leftOut.length > 0) notes.push(leftOutLine(mapped.leftOut));
    } else {
      const mapped = claudeTakeoverMcp(servers);
      if (Object.keys(mapped.servers).length > 0)
        mcpConfigFile = write('mcp', 'json', JSON.stringify({ mcpServers: mapped.servers }), 0o600);
      if (mapped.leftOut.length > 0) notes.push(leftOutLine(mapped.leftOut));
    }
    // Claude's setup adds its skill-name line when plugins come along; Codex gets the instructions alone.
    const text = codex
      ? servers.instructions
      : setupPromptText(servers.instructions, servers.pluginDirs);
    const instructionsFile =
      text === null || text === ''
        ? null
        : write(
            'instructions',
            codex ? 'toml' : 'txt',
            codex ? `${tomlString(text)}\n` : text,
            0o600,
          );
    const command = deps.adapter.takeoverCommand({
      kind: source.kind,
      harness: source.harness,
      cwd: source.cwd,
      providerSessionId: input.providerSessionId,
      model: source.model,
      effort: source.effort,
      launch: source.launch,
      pluginDirs: codex ? [] : servers.pluginDirs,
      instructionsFile,
      mcpConfigFile,
      codexServers,
      sealedEnvFile,
      web: source.web,
    });
    const { script, line } = renderTakeover(command);
    const scriptFile = write('takeover', 'command', script, 0o700);
    return { script: scriptFile, line, notes, tempDirs: servers.tempDirs, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

const leftOutLine = (names: readonly string[]): string =>
  `Left out of your terminal, as the agent can't take them: ${names.join(', ')}.`;
