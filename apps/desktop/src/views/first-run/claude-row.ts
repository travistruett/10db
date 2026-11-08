import {
  AccountProblem,
  type AccountIdentityDto,
  type AgentCopy,
  type ToolCheck,
} from '@10db/contracts';

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
  /** The pinned Claude Code copy 10db fetches and checks; absent where nothing is managed. */
  readonly copy?: AgentCopy | undefined;
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
  const { claude, copy, probing, identity, error } = input;
  if (claude === undefined)
    return {
      mark: 'pending',
      detail: 'Looking for Claude Code…',
      runsAs: null,
      canAddLogin: false,
    };
  if (claude.path === null && copy?.state === 'fetching')
    return {
      mark: 'pending',
      detail: `Downloading Claude Code ${copy.pinned}, the release 10db runs, and checking it against its recorded checksum…`,
      runsAs: null,
      canAddLogin: false,
    };
  if (claude.path === null && copy?.state === 'refused')
    return {
      mark: 'bad',
      detail: `${copy.problem ?? `Claude Code ${copy.pinned} was refused.`} Recheck removes this copy and downloads a fresh one, checked against the same recorded checksum.`,
      runsAs: null,
      canAddLogin: false,
    };
  if (claude.path === null) {
    return {
      mark: 'bad',
      detail: `10db runs its own copy of Claude Code, and none is managed here.`,
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
