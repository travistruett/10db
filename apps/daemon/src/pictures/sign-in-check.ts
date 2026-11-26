import {
  SignInCheckState,
  type AppUrl,
  type ProjectDto,
  type SignInCheckDto,
} from '@10db/contracts';
import { ShotOutcome, type Shot } from './camera';
import { pageAreaRoutes } from './kept-route';
import { pageRouteLoads } from './picture-routes';
import { SignInStep, type SignInResult } from './sign-in';
import type { StorageState } from './storage-state';

// Check Sign-in: runs a project's dev login, signs the picture browser in and loads the app's first
// routed page, so a dev login that stopped working is found when it stops and not when a picture is
// wanted. The same check runs when the app address or the command changes, when the daemon starts and
// once a day.

/** The page a check loads when the project has no page area that loads. */
const ROOT_ROUTE = '/';

/** The first page area's route that loads as it stands, else the app's root. */
export function firstRoutedPage(project: Pick<ProjectDto, 'areas'>): string {
  return pageAreaRoutes(project.areas).find(pageRouteLoads) ?? ROOT_ROUTE;
}

export interface SignInCheckRun {
  readonly now: () => Date;
  /** Keeps the app up for the check, and says whether it answers. */
  readonly hold: () => Promise<
    { readonly up: true } | { readonly up: false; readonly why: string }
  >;
  /** Runs the dev login and the browser's sign-in; null when it was stopped. */
  readonly signIn: () => Promise<SignInResult | null>;
  /** Loads the route at the app address as the signed-in browser. */
  readonly shoot: (route: string, state: StorageState) => Promise<Shot>;
  /** Whether the project's app address is still the one being checked. */
  readonly sameAddress: () => boolean;
  readonly appUrl: AppUrl;
  readonly route: string;
}

/** The words a load that did not come out clean says. */
function loadProblem(shot: Shot): string {
  switch (shot.outcome) {
    case ShotOutcome.Overlay:
      return `The app shows its error overlay: ${shot.overlayText ?? 'no text'}`;
    case ShotOutcome.NoAnswer:
      return 'The app did not answer';
    case ShotOutcome.Elsewhere:
      return 'The browser was signed in, but the page landed on another page of the app';
    case ShotOutcome.Clean:
    case ShotOutcome.Failed:
      return shot.reason ?? 'The page could not be loaded';
  }
}

function checkReport(
  at: string,
  state: SignInCheckState,
  problem: string | null,
  rest: Partial<Pick<SignInCheckDto, 'exitCode' | 'output' | 'route' | 'picture'>> = {},
): SignInCheckDto {
  return { state, at, problem, exitCode: null, output: '', route: null, picture: null, ...rest };
}

/** A check that could not tell, for a reason that is no fault of the dev login. */
export function uncheckedReport(at: Date, problem: string): SignInCheckDto {
  return checkReport(at.toISOString(), SignInCheckState.Unchecked, problem);
}

/** A check's verdict: signed in, failed, or unchecked when the app, not the sign-in, kept it from telling. */
export async function runSignInCheck(run: SignInCheckRun): Promise<SignInCheckDto> {
  const at = run.now().toISOString();
  const report = (
    state: SignInCheckState,
    problem: string | null,
    rest: Partial<Pick<SignInCheckDto, 'exitCode' | 'output' | 'route' | 'picture'>> = {},
  ): SignInCheckDto => checkReport(at, state, problem, rest);
  const held = await run.hold();
  if (!run.sameAddress())
    return report(SignInCheckState.Unchecked, 'The app address changed during the check');
  const result = await run.signIn();
  if (result === null) return report(SignInCheckState.Unchecked, 'The check was stopped');
  if (!result.ok) {
    const { problem, exitCode, output } = result;
    switch (result.step) {
      case SignInStep.Setup:
        return report(SignInCheckState.Unchecked, problem);
      case SignInStep.Command:
        return report(SignInCheckState.Failed, problem, { exitCode, output });
      case SignInStep.Browser:
        // An app that is not running cannot be signed in to: that is not the dev login's fault.
        return held.up
          ? report(SignInCheckState.Failed, problem, { exitCode, output })
          : report(SignInCheckState.Unchecked, `${problem}: the app did not answer (${held.why})`, {
              exitCode,
            });
    }
  }
  if (!run.sameAddress())
    return report(SignInCheckState.Unchecked, 'The app address changed during the check');
  const shot = await run.shoot(run.route, result.state);
  const route = { exitCode: 0, route: run.route };
  if (shot.outcome === ShotOutcome.Clean && shot.png !== null)
    return report(SignInCheckState.SignedIn, null, {
      ...route,
      picture: Buffer.from(shot.png).toString('base64'),
    });
  return report(
    shot.outcome === ShotOutcome.Elsewhere ? SignInCheckState.Failed : SignInCheckState.Unchecked,
    loadProblem(shot),
    route,
  );
}
