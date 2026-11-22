import type { Effort, Provider, SupportedAccountKind } from '@10db/contracts';
import type { TakeoverLaunch } from '../environment';

// What the builder's own terminal runs to continue a chat in the agent's TUI: a description a pure renderer turns
// into a script and a one-line command. It holds no secret value; a key is read from the Keychain when it runs.

/** A command could not be made safe to run: a value holds a NUL, a name is not a name, or the agent is not ready. */
export class TakeoverRefusedError extends Error {
  override readonly name = 'TakeoverRefusedError';
}

/** An argument read from a file when the command runs: `<prefix>$(cat -- '<file>')`, inside double quotes. */
export interface ArgFromFile {
  readonly prefix: string;
  readonly file: string;
}

export type TakeoverArg = string | ArgFromFile;

export const isArgFromFile = (arg: TakeoverArg): arg is ArgFromFile => typeof arg !== 'string';

export interface TakeoverCommand {
  readonly cwd: string;
  /** Variables of the builder's shell the agent must not see. */
  readonly unset: readonly string[];
  /** Every variable whose name starts with one of these is unset too. */
  readonly unsetPrefixes: readonly string[];
  readonly set: Readonly<Record<string, string>>;
  /** Variables filled from the Keychain account named, exported for the agent only. */
  readonly keychain: readonly { readonly variable: string; readonly account: string }[];
  /** Files of `export NAME=value` lines the script reads before the agent starts. */
  readonly sources: readonly string[];
  /** The binary, then its arguments. */
  readonly argv: readonly TakeoverArg[];
}

/** One MCP server for Codex's terminal, as the chat's session had it; `extras` are Codex's own keys for it. */
export type CodexTakeoverServer =
  | {
      readonly kind: 'stdio';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly extras: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'remote';
      readonly name: string;
      readonly url: string;
      /** Each header and the variable that holds its value, read from the sealed file. */
      readonly headerVariables: readonly { readonly header: string; readonly variable: string }[];
      readonly extras: Readonly<Record<string, unknown>>;
    };

/**
 * What a chat's session had, rebuilt for the builder's terminal: the pinned binary, the folder, the agent session
 * to resume, and the setup the chat ran with. Files are the takeover folder's own; nothing here is a secret.
 */
export interface TakeoverSpec {
  /** The account's kind, which says what credential it holds. */
  readonly kind: SupportedAccountKind;
  /** The harness that runs it. */
  readonly harness: Provider;
  /** The pinned agent binary. */
  readonly binary: string;
  readonly cwd: string;
  /** The agent's own session id; checked with `validSessionId` before it reaches a command. */
  readonly providerSessionId: string;
  /** What the agent is launched with for the chat's model. */
  readonly model: string;
  readonly effort: Effort;
  readonly launch: TakeoverLaunch;
  /** The setup's plugin directories, in order. */
  readonly pluginDirs: readonly string[];
  /** The setup's instructions, as a file; null when the chat has none. */
  readonly instructionsFile: string | null;
  /** Claude's MCP config file; null when the chat has no servers. */
  readonly mcpConfigFile: string | null;
  /** Codex's servers; none for Claude. */
  readonly codexServers: readonly CodexTakeoverServer[];
  /** A sealed file of `export` lines for the servers' header variables; null when there are none. */
  readonly sealedEnvFile: string | null;
  /** Whether the project's Web switch is on. */
  readonly web: boolean;
}

// No leading hyphen, so an id can never read as an option.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** The id of an agent session, or `TakeoverRefusedError`: it is the one agent text that reaches a command's options. */
export function validSessionId(id: string): string {
  if (!SESSION_ID.test(id))
    throw new TakeoverRefusedError('the chat’s agent session id is not usable');
  return id;
}
