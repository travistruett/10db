import {
  codexLaneTempRoot,
  ensurePrivateRoot,
  laneTempRoot,
  sandboxFilesRoot,
  SandboxTempDirError,
  SYSTEM_TEMP_ROOT,
  type GateSandbox,
  type LaneSandbox,
} from '../sandbox';

/** Where the sandbox keeps what it makes, and where an earlier 10db kept it. */
export interface SandboxRoots {
  /** The temp dirs of Claude lanes, gates and MCP servers. */
  readonly temp: string;
  /** A ChatGPT lane's temp dir. */
  readonly codexLanes: string;
  /** Sealed files, env files and process ledgers. */
  readonly files: string;
  /** Where an earlier 10db kept them all, swept at start and never written. */
  readonly previous: string;
  /** Why a root was refused, which refuses every lane session and gate; null when none was. */
  readonly refusal: SandboxTempDirError | null;
}

/** The roots a test moves off the machine's; each defaults to the one the daemon uses. */
export interface SandboxRootOptions {
  readonly tmpRoot?: string;
  readonly codexLaneTempRoot?: string;
  readonly filesRoot?: string;
  readonly previousTempRoot?: string;
}

/**
 * The sandbox's roots, each made private to this user (`ensurePrivateRoot`) before anything is put
 * there, as real paths. One that is refused (a link, not a directory, another user's) is kept as
 * given and named in `refusal`: nothing is made, swept or claimed in any of them then.
 */
export function openSandboxRoots(given: SandboxRootOptions, home: string): SandboxRoots {
  const roots = {
    temp: given.tmpRoot ?? laneTempRoot(),
    codexLanes: given.codexLaneTempRoot ?? codexLaneTempRoot(home),
    files: given.filesRoot ?? sandboxFilesRoot(home),
    previous: given.previousTempRoot ?? SYSTEM_TEMP_ROOT,
  };
  try {
    return {
      ...roots,
      temp: ensurePrivateRoot(roots.temp),
      codexLanes: ensurePrivateRoot(roots.codexLanes),
      files: ensurePrivateRoot(roots.files),
      refusal: null,
    };
  } catch (error) {
    if (!(error instanceof SandboxTempDirError)) throw error;
    return { ...roots, refusal: error };
  }
}

/** A lane sandbox that refuses every session with the root's refusal, as a temp dir it can't make. */
export function refusedLaneSandbox(refusal: SandboxTempDirError): LaneSandbox {
  return { forSession: () => Promise.reject(refusal) };
}

/** A gate sandbox that refuses every run with the root's refusal; the gate fails with it. */
export function refusedGateSandbox(refusal: SandboxTempDirError): GateSandbox {
  return { forRun: () => Promise.reject(refusal) };
}
