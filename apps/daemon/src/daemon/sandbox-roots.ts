import {
  codexLaneTempRoot,
  ensurePrivateRoot,
  keepSpotlightOut,
  laneTempRoot,
  sandboxFilesRoot,
  SandboxTempDirError,
  SYSTEM_TEMP_ROOTS,
  type BackupExclusion,
  type GateSandbox,
  type LaneSandbox,
} from '../sandbox';

/** Where the sandbox keeps what it makes, and the system temp dirs every ChatGPT lane writes. */
export interface SandboxRoots {
  /** The temp dirs of Claude lanes, gates and MCP servers. */
  readonly temp: string;
  /** A ChatGPT lane's temp dir. */
  readonly codexLanes: string;
  /** Sealed files, env files and process ledgers. */
  readonly files: string;
  /** Lane-writable, never written by 10db, and swept of its names once the daemon listens. */
  readonly systemTemps: readonly string[];
  /** Why a root was refused, which refuses every lane session and gate; null when none was. */
  readonly refusal: SandboxTempDirError | null;
}

/** The roots a test moves off the machine's; each defaults to the one the daemon uses. */
export interface SandboxRootOptions {
  readonly tmpRoot?: string;
  readonly codexLaneTempRoot?: string;
  readonly filesRoot?: string;
  readonly systemTempRoots?: readonly string[];
}

/** The roots as given or by default, none of them made. */
export function namedSandboxRoots(
  given: SandboxRootOptions,
  home: string,
): Omit<SandboxRoots, 'refusal'> {
  return {
    temp: given.tmpRoot ?? laneTempRoot(),
    codexLanes: given.codexLaneTempRoot ?? codexLaneTempRoot(home),
    files: given.filesRoot ?? sandboxFilesRoot(home),
    systemTemps: given.systemTempRoots ?? SYSTEM_TEMP_ROOTS,
  };
}

/**
 * The sandbox's roots, each made private to this user (`ensurePrivateRoot`) before anything is put
 * there, as real paths, and marked so Spotlight skips it (`keepSpotlightOut`). One that is refused
 * (a link, not a directory, another user's) is kept as named and the refusal recorded: nothing is
 * made, swept or claimed in any of them then.
 */
export function openSandboxRoots(given: SandboxRootOptions, home: string): SandboxRoots {
  const roots = namedSandboxRoots(given, home);
  let open: Pick<SandboxRoots, 'temp' | 'codexLanes' | 'files'>;
  try {
    open = {
      temp: ensurePrivateRoot(roots.temp),
      codexLanes: ensurePrivateRoot(roots.codexLanes),
      files: ensurePrivateRoot(roots.files),
    };
  } catch (error) {
    if (!(error instanceof SandboxTempDirError)) throw error;
    return { ...roots, refusal: error };
  }
  for (const root of [open.temp, open.codexLanes, open.files]) keepSpotlightOut(root);
  return { ...roots, ...open, refusal: null };
}

/** The daemon's logger, as far as the backup exclusion tells it what it could not do. */
export interface BackupLog {
  warn(fields: object, message: string): void;
}

/**
 * Asks Time Machine to skip each open root (`exclude`, `tmutil addexclusion` in the daemon): every
 * lane's package caches are in them, and none is worth a backup. Over a refused root it asks
 * nothing. A root it could not exclude is logged, not fatal; one the daemon's stop (`signal`) ended
 * is no failure.
 */
export async function keepRootsOutOfBackups(
  roots: SandboxRoots,
  exclude: BackupExclusion,
  log: BackupLog,
  signal: AbortSignal,
): Promise<void> {
  if (roots.refusal !== null) return;
  await Promise.all(
    [roots.temp, roots.codexLanes, roots.files].map((root) =>
      exclude(root, signal).catch((error: unknown) => {
        if (signal.aborted) return;
        log.warn(
          { root, err: error instanceof Error ? error.message : String(error) },
          'Time Machine could not be told to skip a sandbox root, so it may be backed up',
        );
      }),
    ),
  );
}

/** Every root a lane writes: both lanes' temp roots and the system temp dirs. */
export function laneWrittenRootsOf(roots: Omit<SandboxRoots, 'refusal'>): string[] {
  return [roots.temp, roots.codexLanes, ...roots.systemTemps];
}

/** Every root a lane writes, and the files root: none is a place for a project or a worktree. */
export function allSandboxRootsOf(roots: Omit<SandboxRoots, 'refusal'>): string[] {
  return [...laneWrittenRootsOf(roots), roots.files];
}

/** What the lane and gate sandboxes are given of the roots, the same for every caller. */
export function sandboxDepsOf(roots: Omit<SandboxRoots, 'refusal'>): {
  readonly tmpRoot: string;
  readonly codexLaneTempRoot: string;
  readonly filesRoot: string;
  readonly laneWritableRoots: readonly string[];
} {
  return {
    tmpRoot: roots.temp,
    codexLaneTempRoot: roots.codexLanes,
    filesRoot: roots.files,
    laneWritableRoots: roots.systemTemps,
  };
}

/**
 * The lane and gate sandboxes, built over open roots. Over a refused root neither is built: each
 * session and run is refused with the root's reason, as a temp dir the sandbox can't make is, so the
 * runner fails the lane and the gate runner fails the gate, each saying why.
 */
export function sandboxesFor(
  roots: SandboxRoots,
  build: { readonly lane: () => LaneSandbox; readonly gate: () => GateSandbox },
): { readonly lane: LaneSandbox; readonly gate: GateSandbox } {
  const { refusal } = roots;
  if (refusal === null) return { lane: build.lane(), gate: build.gate() };
  return {
    lane: { forSession: () => Promise.reject(refusal), judgeSetup: () => Promise.reject(refusal) },
    gate: { forRun: () => Promise.reject(refusal) },
  };
}
