import type { SelfUpdateBlockerDto } from '@10db/contracts';
import type { BuildInfo } from './build-info';

/** The switch's label in Settings; cards and messages name it exactly. */
export const SELF_UPDATE_SWITCH = 'Update 10db by itself';

/**
 * Why this app can never update itself, whatever the switch says, or null when it can. These are
 * facts about the install, known at start: a run from source, a build that knows no repository, a
 * copy that is not the one in Applications, no gh to ask GitHub with.
 */
export function cannotUpdate(
  build: Pick<BuildInfo, 'repository' | 'updatable'> | null,
  ghInstalled: boolean,
): SelfUpdateBlockerDto | null {
  if (build === null) {
    return {
      kind: 'source',
      message: 'This app is running from source, so it never updates itself.',
    };
  }
  if (build.repository === null) {
    return {
      kind: 'no-repository',
      message:
        'This build names no repository in build-info.json, so 10db does not know where to update from. Install a build made by CI (make install-app).',
    };
  }
  if (!build.updatable) {
    return {
      kind: 'not-in-applications',
      message:
        'This copy of 10db is not the one in /Applications, so it is left as it is. Run the app installed in /Applications to have it update itself.',
    };
  }
  if (!ghInstalled) {
    return {
      kind: 'gh-missing',
      message:
        'The GitHub command line (gh) is not installed, so 10db cannot ask GitHub for new builds. Install it (brew install gh), sign in with gh auth login, and restart 10db.',
    };
  }
  return null;
}
