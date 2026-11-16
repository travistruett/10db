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
