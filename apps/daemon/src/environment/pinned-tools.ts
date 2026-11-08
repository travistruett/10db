import { join } from 'node:path';
import { z } from 'zod';
import { defaultDataDir } from '../runtime-files';
import { AGENT_PINS, AgentTool, type AgentPin } from './agent-pins';
import {
  downloadFile,
  ensurePinned,
  extractWithTar,
  PinnedToolError,
  prunePinned,
  type InstallDeps,
} from './pinned-install';

/** How often upstream is asked for its newest release: well inside the day the builder is promised. */
export const RELEASE_CHECK_MS = 6 * 60 * 60_000;
const LATEST_TIMEOUT_MS = 15_000;
/** Claude Code's own updater must never replace what a lane runs; this is the switch it documents. */
export const AUTOUPDATE_OFF = { DISABLE_AUTOUPDATER: '1' } as const;

export const AgentState = { Fetching: 'fetching', Ready: 'ready', Refused: 'refused' } as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

/** One agent CLI as the daemon runs it. */
export interface AgentStatus {
  readonly tool: AgentTool;
  readonly label: string;
  /** The release 10db is verified on. */
  readonly pinned: string;
  readonly state: AgentState;
  /** The executable, once ready. */
  readonly path: string | null;
  /** What `--version` printed, once ready. */
  readonly version: string | null;
  /** Why the copy was refused, or could not be fetched. */
  readonly problem: string | null;
  /** The newest upstream release, when it is newer than the pin. */
  readonly newerRelease: string | null;
}

/** What the daemon exposes of its agent CLIs: their status now, and a try again for those not ready. */
export interface AgentTools {
  statuses(): readonly AgentStatus[];
  /**
   * Starts fetching or checking again every copy that is not ready (a refused copy is removed and
   * fetched afresh; one already fetching is left to finish), and asks upstream for its newest release.
   * Resolves once that answer is in, without waiting for the downloads.
   */
  retry(): Promise<void>;
}

export type FetchLatest = (url: string) => Promise<string>;
export type PinnedProbe = (
  path: string,
  env: Readonly<Record<string, string>>,
) => Promise<string | null>;

const LatestDocument = z.object({ version: z.string() });

export const fetchLatestVersion: FetchLatest = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  return LatestDocument.parse(await response.json()).version;
};

const triple = (version: string): [number, number, number] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** Whether `candidate` is a later release than `base`. A pre-release, or anything unreadable, is not. */
export function isNewerRelease(candidate: string, base: string): boolean {
  const a = triple(candidate);
  const b = triple(base);
  if (a === null || b === null) return false;
  for (const [i, part] of a.entries()) {
    const other = b[i] ?? 0;
    if (part !== other) return part > other;
  }
  return false;
}

/**
 * Where the live tests keep their pinned copies: a tools folder of their own beside the app's, so a
 * live test of a newer pin never touches the copy the running app runs, and the app never prunes theirs.
 */
export function liveTestDataDir(): string {
  return join(defaultDataDir(), 'live-tests');
}

/**
 * The pinned copy of `tool` under `liveTestDataDir()`, fetched and verified if need be. The live tests
 * run on it, so a pin is verified on the release it names. Nothing else in that folder is removed.
 */
export function ensureAgent(tool: AgentTool): Promise<string> {
  return ensurePinned(liveTestDataDir(), AGENT_PINS[tool], {
    download: downloadFile,
    extract: extractWithTar,
  });
}

export interface PinnedToolsOptions {
  readonly dataDir: string;
  readonly pins?: Readonly<Record<AgentTool, AgentPin>>;
  /** A path run in place of the pinned copy (`TENDB_CLAUDE_PATH`): nothing is fetched or checked for it. */
  readonly overrides?: Partial<Record<AgentTool, string>>;
  readonly install?: InstallDeps;
  readonly probe: PinnedProbe;
  readonly fetchLatest?: FetchLatest;
  readonly releaseCheckMs?: number;
}

export interface RunningAgentTools extends AgentTools {
  /** Resolves once every copy has been fetched or refused and the first release check is done. */
  settled(): Promise<void>;
  stop(): void;
}

/**
 * Fetches and verifies the pinned copy of each agent CLI in the background, and keeps asking upstream
 * for its newest release. Sessions that start before a copy is ready end with the status's reason.
 */
export function startPinnedTools(options: PinnedToolsOptions): RunningAgentTools {
  const pins = options.pins ?? AGENT_PINS;
  const install = options.install ?? { download: downloadFile, extract: extractWithTar };
  const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
  const tools = Object.values(AgentTool);
  const state = new Map<AgentTool, Omit<AgentStatus, 'newerRelease'>>();
  const latest = new Map<AgentTool, string>();
  const base = (tool: AgentTool) => {
    const pin = pins[tool];
    return { tool, label: pin.label, pinned: pin.version } as const;
  };
  for (const tool of tools)
    state.set(tool, {
      ...base(tool),
      state: AgentState.Fetching,
      path: null,
      version: null,
      problem: null,
    });

  const settle = (tool: AgentTool, next: Partial<Omit<AgentStatus, 'tool'>>): void => {
    const current = state.get(tool);
    if (current) state.set(tool, { ...current, ...next });
  };

  async function check(tool: AgentTool, replaceRefused: boolean): Promise<void> {
    const override = options.overrides?.[tool];
    const pin = pins[tool];
    try {
      const path =
        override ?? (await ensurePinned(options.dataDir, pin, install, { replaceRefused }));
      const version = await options.probe(path, { PATH: '/usr/bin:/bin', ...AUTOUPDATE_OFF });
      if (version === null)
        throw new PinnedToolError(pin, `${path} does not run: --version failed`);
      if (override === undefined && !version.includes(pin.version))
        throw new PinnedToolError(pin, `${path} reports "${version}", which is not ${pin.version}`);
      // Only the daemon's own verified copy lets an older release go.
      if (override === undefined) await prunePinned(options.dataDir, pin);
      settle(tool, { state: AgentState.Ready, path, version, problem: null });
    } catch (error) {
      const refusal =
        error instanceof PinnedToolError
          ? error
          : new PinnedToolError(pin, error instanceof Error ? error.message : String(error));
      settle(tool, {
        state: AgentState.Refused,
        path: null,
        version: null,
        problem: refusal.message,
      });
    }
  }

  // One fetch or check per tool at a time: a second would race the first for the same folder.
  const inFlight = new Map<AgentTool, Promise<void>>();
  function prepare(tool: AgentTool, replaceRefused = false): Promise<void> {
    const running = inFlight.get(tool);
    if (running) return running;
    settle(tool, { state: AgentState.Fetching });
    const next = check(tool, replaceRefused).finally(() => {
      inFlight.delete(tool);
    });
    inFlight.set(tool, next);
    return next;
  }

  async function checkReleases(): Promise<void> {
    await Promise.all(
      tools.map(async (tool) => {
        try {
          latest.set(tool, await fetchLatest(pins[tool].latestUrl));
        } catch {
          // Upstream can't be reached: the last answer stands.
        }
      }),
    );
  }

  let working: Promise<unknown> = Promise.all([
    ...tools.map((tool) => prepare(tool)),
    checkReleases(),
  ]);
  const timer = setInterval(() => {
    void retry();
  }, options.releaseCheckMs ?? RELEASE_CHECK_MS);
  timer.unref();

  async function retry(): Promise<void> {
    const fetches = tools
      .filter((tool) => state.get(tool)?.state !== AgentState.Ready)
      .map((tool) => prepare(tool, state.get(tool)?.state === AgentState.Refused));
    const releases = checkReleases();
    const before = working;
    working = Promise.all([before, ...fetches, releases]);
    // A download can take minutes: the answer carries the release check, and says a copy is fetching.
    await releases;
  }

  return {
    statuses: () =>
      tools.flatMap((tool) => {
        const current = state.get(tool);
        const newest = latest.get(tool);
        return current
          ? [
              {
                ...current,
                newerRelease:
                  newest !== undefined && isNewerRelease(newest, pins[tool].version)
                    ? newest
                    : null,
              },
            ]
          : [];
      }),
    retry,
    settled: async () => {
      await working;
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}
