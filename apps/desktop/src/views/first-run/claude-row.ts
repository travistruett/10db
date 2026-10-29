import { AccountProblem, type AccountIdentityDto, type ToolCheck } from '@10db/contracts';

/** The places 10db looks for Claude Code: the install prefixes, then Claude Code's own folders in the home folder. */
const CLAUDE_LOOKED_IN =
  '/opt/homebrew/bin, /usr/local/bin, /usr/bin, ~/.local/bin and ~/.claude/local';

export type SetupMark = 'ok' | 'warn' | 'bad' | 'pending';

export interface SetupRow {
  readonly mark: SetupMark;
  readonly detail: string;
}

export interface ClaudeRow extends SetupRow {
  /** The login tasks will run as; null unless Claude Code is signed in and says as whom. */
  readonly runsAs: string | null;
  /** Whether the row offers "Add Another Login": only once Claude Code has answered about the login. */
  readonly canAddLogin: boolean;
}

export interface ClaudeRowInput {
  /** Claude Code as the system check found it; undefined while that check hasn't answered. */
  readonly claude: ToolCheck | undefined;
  /** The identity probe is running. */
  readonly probing: boolean;
  readonly identity: AccountIdentityDto | null;
  /** Why the probe request itself failed. */
  readonly error: string | null;
}

const STARTING = 'Starting Claude Code to read the account…';

/** A personal plan's organization is just "<email>'s Organization"; only a real one is worth showing. */
function shownOrganization(identity: AccountIdentityDto, email: string | null): string | null {
  const organization = identity.organization;
  if (organization === null || email === null) return organization;
  return organization === `${email}'s Organization` ? null : organization;
}

/**
 * The Claude Code row of the setup check: what the system check and the identity probe together say.
 * A login 10db hasn't recorded yet still counts as signed in; the account preparer records it.
 */
export function claudeRow(input: ClaudeRowInput): ClaudeRow {
  const { claude, probing, identity, error } = input;
  if (claude === undefined)
    return {
      mark: 'pending',
      detail: 'Looking for Claude Code…',
      runsAs: null,
      canAddLogin: false,
    };
  if (claude.path === null) {
    return {
      mark: 'bad',
      detail: `Not found in ${CLAUDE_LOOKED_IN}. Install Claude Code, then recheck.`,
      runsAs: null,
      canAddLogin: false,
    };
  }
  if (probing) return { mark: 'pending', detail: STARTING, runsAs: null, canAddLogin: false };
  if (error !== null) return { mark: 'bad', detail: error, runsAs: null, canAddLogin: false };
  if (identity === null)
    return { mark: 'pending', detail: STARTING, runsAs: null, canAddLogin: false };

  const refusal = identity.refusal;
  if (refusal !== null && refusal.problem !== AccountProblem.Unconfirmed) {
    return { mark: 'bad', detail: refusal.message, runsAs: null, canAddLogin: true };
  }
  const email = identity.email ?? refusal?.seenIdentity ?? null;
  const organization = shownOrganization(identity, email);
  const who =
    email === null ? '' : ` as ${email}${organization === null ? '' : ` · ${organization}`}`;
  return {
    mark: 'ok',
    detail: `Signed in${who}. Tasks run as this login.`,
    runsAs: email,
    canAddLogin: true,
  };
}
