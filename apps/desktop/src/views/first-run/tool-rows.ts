import type { ToolCheck } from '@10db/contracts';
import type { SetupRow } from './claude-row';

const INSTALL_PREFIXES = '/opt/homebrew/bin, /usr/local/bin and /usr/bin';

/** git is required: the factory cannot work without it. */
export function gitRow(git: ToolCheck | undefined): SetupRow {
  if (git === undefined) return { mark: 'pending', detail: 'Looking for git…' };
  if (git.path === null) return { mark: 'bad', detail: `Not found in ${INSTALL_PREFIXES}.` };
  return { mark: 'ok', detail: git.version ?? git.path };
}

/** gh is optional: without it only "Commit directly" is possible. */
export function ghRow(gh: ToolCheck | undefined): SetupRow {
  if (gh === undefined) return { mark: 'pending', detail: 'Looking for the GitHub CLI…' };
  if (gh.path === null)
    return { mark: 'warn', detail: 'Not found. Needed only for pull requests.' };
  if (gh.signedIn === null) {
    return {
      mark: 'warn',
      detail: 'Not signed in. Run gh auth login in a terminal, then recheck.',
    };
  }
  return { mark: 'ok', detail: `${gh.version ?? gh.path}, signed in as ${gh.signedIn}` };
}
