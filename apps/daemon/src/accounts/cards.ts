import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountKind,
  AccountPauseReason,
  AccountProblem,
  accountDisplayName,
  BedrockSettings,
  needsSecret,
  type AccountDto,
  type AccountId,
  type AccountRefusal,
  type InboxOption,
  type ProjectDto,
} from '@10db/contracts';
import type { AccountRow, Json } from '@10db/db';
import { signInCommand } from '../environment';
import type { CapStatus } from './cap';

export interface AccountCard {
  readonly title: string;
  readonly body: string;
  readonly foldKey: string;
  readonly detail: Record<string, Json>;
  readonly options?: readonly InboxOption[];
}

/** Cards about an account fold per project on what they are about. */
export function accountFoldKey(id: AccountId, ...parts: readonly string[]): string {
  return ['account', id, ...parts].join(':');
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function detail(
  account: AccountRow,
  reason: AccountPauseReason | null,
  problem: AccountProblem | null,
  seenIdentity: string | null,
  extra: Record<string, Json> = {},
): Record<string, Json> {
  return {
    [ACCOUNT_CARD_DETAIL]: { accountId: account.id, reason, problem, seenIdentity, ...extra },
  };
}

function signInAgain(account: AccountRow): string {
  if (account.kind === AccountKind.ClaudeSubscription)
    return `Sign in again with: ${signInCommand(account.configDir)}`;
  if (account.kind === AccountKind.Bedrock) {
    const settings = BedrockSettings.safeParse(account.settings);
    if (settings.success && settings.data.awsProfile !== null)
      return `Sign in again with: aws sso login --profile ${settings.data.awsProfile}`;
  }
  return `Check the account's key, then set it again with PUT /accounts/${account.id}/secret.`;
}

/** The exact step that fixes the problem for this account (accounts spec §5 "Expired credentials"). */
export function fixFor(account: AccountRow, problem: AccountProblem): string {
  switch (problem) {
    case AccountProblem.SignedOut:
      return `${signInAgain(account)} Then answer Resume.`;
    case AccountProblem.Unconfirmed:
      return `Confirm the identity ${account.label} runs as, or set it with PATCH /accounts/${account.id}.`;
    case AccountProblem.IdentityMismatch:
      return account.kind === AccountKind.ClaudeSubscription
        ? `If that is the right account, confirm it; otherwise ${signInAgain(account).toLowerCase()} and answer Resume.`
        : `Check the account's key and its expected organization (PATCH /accounts/${account.id}), then answer Resume.`;
    case AccountProblem.WrongCredentials:
      return "10db strips every other credential, so a newer Claude Code may read a different variable; the system check names the version 10db's checks were verified on.";
    case AccountProblem.SecretMissing:
    case AccountProblem.SecretChanged:
      return `Set the secret with PUT /accounts/${account.id}/secret; the account resumes when it is saved.`;
    case AccountProblem.CannotBill:
      return "Check the account's billing with its provider, then answer Resume.";
  }
}

/** The fold key part of the card that offers a project the way back. */
export const MOVE_BACK_CARD = 'available';

/** What an account still needs before work can run on it; a move there waits until it has it. */
function stillNeeds(account: AccountDto): string {
  if (account.kind === AccountKind.ClaudeSubscription && account.expectedIdentity === null)
    return ' (needs sign-in)';
  if (needsSecret(account.kind, account.settings) && !account.secretSet) return ' (needs a secret)';
  return '';
}

/** How an option names an account the project could move to. */
const offered = (account: AccountDto): string =>
  `${accountDisplayName(account)}${stillNeeds(account)}`;

/**
 * A usage limit paused every lane on the account. The card offers to continue the project on each
 * account it could move to now (accounts spec §6); a lane in flight starts there from its handoff.
 */
export function usageLimitCard(
  account: AccountRow,
  until: Date,
  project: ProjectDto,
  targets: readonly AccountDto[],
): AccountCard {
  const moves = targets.map((t) => ({ choice: `Continue on ${offered(t)}`, accountId: t.id }));
  return {
    title: `${account.label} usage limit reached`,
    body: `Every lane on ${account.label} is paused until ${until.toISOString()}. Work resumes automatically.${
      moves.length > 0
        ? ` Or continue ${project.name} on another account now: each lane's next session runs there from its latest handoff, and 10db asks whether to move it back once ${account.label} is available again.`
        : ''
    }`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.UsageLimit),
    detail: detail(account, AccountPauseReason.UsageLimit, null, null, { moves }),
    ...(moves.length > 0
      ? {
          options: [
            ...moves.map((m) => ({
              label: m.choice,
              description: `Move ${project.name} there until ${account.label} is available again`,
            })),
            { label: AccountCardChoice.Later, description: `Wait for ${account.label}` },
          ],
        }
      : {}),
  };
}

/** The account a project left for its usage limit is free again; nothing moves until the builder says so. */
export function moveBackCard(
  project: ProjectDto,
  from: AccountRow,
  current: AccountRow,
): AccountCard {
  const reset =
    project.moveBackAt === null
      ? "10db doesn't know whether that limit has reset, because Claude Code didn't say when it would"
      : 'that limit has reset';
  return {
    title: `${from.label} is available again: move ${project.name} back?`,
    body: `${project.name} moved to ${current.label} when ${from.label} reached its usage limit, and ${reset}. Move it back, and each lane's next session runs on ${from.label} from its latest handoff; or stay on ${current.label}.`,
    foldKey: accountFoldKey(from.id, MOVE_BACK_CARD),
    detail: detail(from, null, null, null, {
      moves: [{ choice: AccountCardChoice.MoveBack, accountId: from.id }],
      moveBack: true,
    }),
    options: [
      {
        label: AccountCardChoice.MoveBack,
        description: `Run ${project.name} on ${accountDisplayName(from)} again`,
      },
      {
        label: AccountCardChoice.Stay,
        description: `Keep ${project.name} on ${accountDisplayName(current)}`,
      },
    ],
  };
}

/** The card's body is rewritten as running sessions end, so it shows the final overshoot. */
export function capCard(account: AccountRow, cap: CapStatus): AccountCard {
  const over = cap.spentUsd - cap.capUsd;
  return {
    title: `${account.label} reached its monthly cap`,
    body: `${money(cap.spentUsd)} of its ${money(cap.capUsd)} cap is spent in ${cap.window.month}${over > 0 ? `, ${money(over)} over` : ''}. New sessions on ${account.label} wait until ${cap.window.end.toISOString()} or until the cap is raised. Sessions already running finish, and this card shows what they add.`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.MonthlyCap),
    detail: detail(account, AccountPauseReason.MonthlyCap, null, null),
  };
}

/** A refusal names what Claude Code reported in the body and the detail only; never in logs. */
export function refusedCard(account: AccountRow, refusal: AccountRefusal): AccountCard {
  const seen =
    refusal.seenIdentity === null ? '' : ` Claude Code reported ${refusal.seenIdentity}.`;
  return {
    title: `${account.label}: sessions refused`,
    body: `${refusal.message}.${seen} ${account.label}'s work waits until the account is fixed. ${fixFor(account, refusal.problem)}`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.Refused, refusal.problem),
    detail: detail(account, AccountPauseReason.Refused, refusal.problem, refusal.seenIdentity),
    options: [
      ...(account.kind === AccountKind.ClaudeSubscription && refusal.seenIdentity !== null
        ? [
            {
              label: AccountCardChoice.Confirm,
              description: `Run ${account.label} as ${refusal.seenIdentity} from now on`,
            },
          ]
        : []),
      { label: AccountCardChoice.Resume, description: 'I fixed it: try the account again' },
      { label: AccountCardChoice.Later, description: 'Keep its work waiting' },
    ],
  };
}

/** For an account on its own directory: the builder confirms the email Claude Code reported (spec §5). */
export function confirmCard(account: AccountRow, email: string): AccountCard {
  return {
    title: `Confirm the account ${account.label}`,
    body: `Claude Code in ${account.configDir ?? "Claude Code's default directory"} is signed in as ${email}. Confirm it, and ${account.label}'s sessions run only while they report this email.`,
    foldKey: accountFoldKey(account.id, AccountProblem.Unconfirmed),
    detail: detail(account, null, AccountProblem.Unconfirmed, email),
    options: [
      { label: AccountCardChoice.Confirm, description: `Run ${account.label} as ${email}` },
      { label: AccountCardChoice.Later, description: 'Keep its work waiting' },
    ],
  };
}

/**
 * A subscription with no login. `why` is what the probe met when it got no answer at all: a signed-out
 * directory may report nothing, so that gets the sign-in command too.
 */
export function signInCard(account: AccountRow, why: string | null = null): AccountCard {
  const seen =
    why === null
      ? `Claude Code is not signed in for ${account.label}`
      : `${why}, so ${account.label} may be signed out`;
  return {
    title: `Sign in the account ${account.label}`,
    body: `${seen}. Its work waits; 10db tries again in a minute. Sign in with: ${signInCommand(account.configDir)}`,
    foldKey: accountFoldKey(account.id, AccountProblem.SignedOut),
    detail: detail(account, null, AccountProblem.SignedOut, null),
  };
}

/**
 * The default account's identity is recorded from its first probe without a Confirm (it is the builder's current
 * login), so this card says which login that was. It holds no work.
 */
export function recordedCard(account: AccountRow, email: string): AccountCard {
  return {
    title: `${account.label} runs as ${email}`,
    body: `10db recorded ${email}, the login in ${account.configDir ?? "Claude Code's default directory"}, as ${account.label}'s identity, and runs its sessions only while they report it. If that is the wrong login, sign in as the right one with: ${signInCommand(account.configDir)}. The next session is then refused, and its card offers Confirm.`,
    foldKey: accountFoldKey(account.id, 'recorded'),
    detail: detail(account, null, null, email),
  };
}

export function secretCard(account: AccountRow): AccountCard {
  return {
    title: `Set the secret of ${account.label}`,
    body: `${account.label} has no secret yet, so its work waits. ${fixFor(account, AccountProblem.SecretMissing)}`,
    foldKey: accountFoldKey(account.id, AccountProblem.SecretMissing),
    detail: detail(account, null, AccountProblem.SecretMissing, null),
  };
}

/** A first-party directory that reports credentials a subscription can't run on; signing in doesn't change that. */
export function credentialsCard(account: AccountRow, refusal: AccountRefusal): AccountCard {
  return {
    title: `Fix the credentials of ${account.label}`,
    body: `${refusal.message}. ${account.label}'s work waits; 10db tries again in a minute. ${fixFor(account, AccountProblem.WrongCredentials)}`,
    foldKey: accountFoldKey(account.id, AccountProblem.WrongCredentials),
    detail: detail(account, null, AccountProblem.WrongCredentials, null),
  };
}
