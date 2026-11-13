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

  async function probe(): Promise<Probed> {
    let state: GithubState;
    let login: string | null = null;
    try {
      login = await deps.readLogin();
      state = login === null ? GithubState.SignedOut : GithubState.SignedIn;
    } catch (error) {
      // Anything but a plain "no gh" is a login nobody could read, never a signed-out one.
      state =
        error instanceof GhError && error.kind === GhFailure.NotInstalled
          ? GithubState.NotInstalled
          : GithubState.Unreachable;
    }
    cached = { state, login, at: deps.clock.now() };
    return cached;
  }

  function probeOnce(): Promise<Probed> {
    probing ??= probe().finally(() => {
      probing = null;
    });
    return probing;
  }

  const login = createGithubLogin({
    clock: deps.clock,
    spawn: deps.spawn,
    resolveGh: deps.resolveGh,
    env: deps.env,
    // The new login is cached before the end is announced, so the screen that refetches on the event
    // reads it.
    readLogin: async () => (await probeOnce()).login,
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
      return dto(fresh && cached !== null ? cached : await probeOnce());
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
