import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountKind,
  AccountPauseReason,
  AccountProblem,
  BedrockSettings,
  type AccountId,
  type AccountRefusal,
  type InboxOption,
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
): Record<string, Json> {
  return { [ACCOUNT_CARD_DETAIL]: { accountId: account.id, reason, problem, seenIdentity } };
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

export function usageLimitCard(account: AccountRow, until: Date): AccountCard {
  return {
    title: `${account.label} usage limit reached`,
    body: `Every lane on ${account.label} is paused until ${until.toISOString()}. Work resumes automatically.`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.UsageLimit),
    detail: detail(account, AccountPauseReason.UsageLimit, null, null),
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
