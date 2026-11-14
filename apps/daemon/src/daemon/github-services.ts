import {
  GithubState,
  type GithubLoginEndedData,
  type GithubSigninDto,
  type GithubStatusDto,
} from '@10db/contracts';
import type { ApiServices } from '../api';
import type { Clock } from '../clock';
import { createGithubLogin, GhError, GhFailure, type GhLoginSpawn } from '../github';

/** How long a probed login is answered from memory before the next status read probes again. */
export const STATUS_FRESH_MS = 60_000;

/** The GitHub card's side of the HTTP API: gh's login and the Sign In that changes it. */
export type GithubApiServices = Pick<
  ApiServices,
  'githubStatus' | 'startGithubSignin' | 'cancelGithubSignin'
>;

export interface GithubServices extends GithubApiServices {
  /** Stops a running sign-in's gh when the daemon stops. */
  stop(): void;
}

interface Probed {
  readonly state: GithubState;
  readonly login: string | null;
  readonly at: Date;
}

export function createGithubServices(deps: {
  readonly clock: Clock;
  readonly spawn: GhLoginSpawn;
  /** Looks for gh again in the install prefixes and makes the daemon's gh calls use what it finds. */
  readonly resolveGh: () => string | null;
  /** gh's login: null when signed out; throws a GhError when it can't tell. */
  readonly readLogin: () => Promise<string | null>;
  readonly env: () => Readonly<Record<string, string>>;
  readonly emit: (data: GithubLoginEndedData) => void;
}): GithubServices {
  let cached: Probed | null = null;
  let probing: Promise<Probed> | null = null;

  /**
   * No gh is not installed; a rejected token arrives as SignedOut. Every other failure (no network, a
   * timeout, a GitHub outage or rate limit) is unreachable, never signed out: gh may well be signed in.
   */
  function stateOfFailure(error: unknown): GithubState {
    if (error instanceof GhError) {
      if (error.kind === GhFailure.NotInstalled) return GithubState.NotInstalled;
      if (error.kind === GhFailure.SignedOut) return GithubState.SignedOut;
      return GithubState.Unreachable;
    }
    return GithubState.Unreachable;
  }

  async function probe(): Promise<Probed> {
    let state: GithubState;
    let login: string | null = null;
    try {
      login = await deps.readLogin();
      state = login === null ? GithubState.SignedOut : GithubState.SignedIn;
    } catch (error) {
      state = stateOfFailure(error);
    }
    cached = { state, login, at: deps.clock.now() };
    return cached;
  }

  /** A stale status read joins the probe that is running. */
  function probeOnce(): Promise<Probed> {
    return probing ?? probeAfterRunning();
  }

  /**
   * A probe that starts once the running one ends and answers its own result: the running one may have
   * read gh before it saved a login or before it was found again.
   */
  function probeAfterRunning(): Promise<Probed> {
    const run: Promise<Probed> = (probing ?? Promise.resolve()).then(probe, probe).finally(() => {
      if (probing === run) probing = null;
    });
    probing = run;
    return run;
  }

  const login = createGithubLogin({
    clock: deps.clock,
    spawn: deps.spawn,
    resolveGh: deps.resolveGh,
    env: deps.env,
    // The new login is cached before the end is announced, so the screen that refetches on the event
    // reads it.
    readLogin: async () => (await probeAfterRunning()).login,
    ended: deps.emit,
  });

  function dto(probed: Probed): GithubStatusDto {
    return {
      state: probed.state,
      login: probed.login,
      checkedAt: probed.at.toISOString(),
      signingIn: login.current(),
    };
  }

  return {
    async githubStatus(recheck) {
      if (recheck) deps.resolveGh();
      const fresh =
        !recheck &&
        cached !== null &&
        deps.clock.now().getTime() - cached.at.getTime() < STATUS_FRESH_MS;
      if (fresh && cached !== null) return dto(cached);
      return dto(await (recheck ? probeAfterRunning() : probeOnce()));
    },
    async startGithubSignin(): Promise<GithubSigninDto> {
      const { code, url } = await login.start();
      return { code, url };
    },
    cancelGithubSignin() {
      login.cancel();
    },
    stop() {
      login.stop();
    },
  };
}
