import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountKind,
  AccountPauseReason,
  AccountProblem,
  accountDisplayName,
  BedrockSettings,
  needsSecret,
  signsInWithLogin,
  type AccountDto,
  type AccountId,
  type AccountRefusal,
  type InboxOption,
  type ProjectDto,
} from '@10db/contracts';
import type { AccountRow, Json } from '@10db/db';
import { signInCommand, signInCommandFor } from '../environment';
import type { NamedModel } from '../catalogue';
import type { CapStatus } from './cap';
import type { UsageReport } from './usage-reports';

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

/** The agent that runs the account's sessions, as a card names it. */
const agentOf = (account: Pick<AccountRow, 'kind'>): string =>
  account.kind === AccountKind.CodexSignin ? 'Codex' : 'Claude Code';

function signInAgain(account: AccountRow): string {
  if (signsInWithLogin(account.kind)) return `Sign in again with: ${signInCommandFor(account)}`;
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
      return signsInWithLogin(account.kind)
        ? `If that is the right account, confirm it; otherwise sign in again with: ${signInCommandFor(account)} and answer Resume.`
        : `Check the account's key and its expected organization (PATCH /accounts/${account.id}), then answer Resume.`;
    case AccountProblem.WrongCredentials:
      return `10db strips every other credential, so a newer ${agentOf(account)} may read a different variable; the system check names the version 10db's checks were verified on.`;
    case AccountProblem.SecretMissing:
    case AccountProblem.SecretChanged:
      return `Set the secret with PUT /accounts/${account.id}/secret; the account resumes when it is saved.`;
    case AccountProblem.KeychainUnavailable:
      return "Unlock the login Keychain, and allow 10db's access if macOS asks, then answer Resume.";
    case AccountProblem.CannotBill:
      return "Check the account's billing with its provider, then answer Resume.";
    case AccountProblem.NoUsableModel:
      return `Choose a model for each tier under Settings › Accounts › ${account.label}, or wait for the account's model list to change, then answer Resume.`;
    case AccountProblem.StartTimeout:
      // Only a subscription is paused for this, but the card must not name a command that does not apply.
      return signsInWithLogin(account.kind)
        ? `${agentOf(account)} starts slowly when the Mac is under load, so answer Resume once the load settles. If the account is signed out after all, sign in with: ${signInCommandFor(account)} first.`
        : `${agentOf(account)} starts slowly when the Mac is under load, so answer Resume once the load settles.`;
  }
}

/** The fold key part of the card that offers a project the way back. */
export const MOVE_BACK_CARD = 'available';

/** What an account still needs before work can run on it; a move there waits until it has it. */
function stillNeeds(account: AccountDto): string {
  if (signsInWithLogin(account.kind) && account.expectedIdentity === null)
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
  until: Date | null,
  project: ProjectDto,
  targets: readonly AccountDto[],
): AccountCard {
  const moves = targets.map((t) => ({ choice: `Continue on ${offered(t)}`, accountId: t.id }));
  const paused =
    until === null
      ? 'until the account is fixed.'
      : `until ${until.toISOString()}. Work resumes automatically.`;
  return {
    title: `${account.label} usage limit reached`,
    body: `Every lane on ${account.label} is paused ${paused}${
      moves.length > 0
        ? ` Or continue ${project.name} on another account now: each lane's next session runs there from its latest handoff, and 10db asks whether to move it back once ${account.label} is available again.`
        : ''
    }`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.UsageLimit),
    detail: detail(account, AccountPauseReason.UsageLimit, null, null, { moves }),
    // Later is always offered, so a stale move choice is refused rather than recorded as an answer.
    options: [
      ...moves.map((m) => ({
        label: m.choice,
        description: `Move ${project.name} there until ${account.label} is available again`,
      })),
      { label: AccountCardChoice.Later, description: `Wait for ${account.label}` },
    ],
  };
}

export const USAGE_HIGH_CARD = 'usage_high';
export const MOVED_CARD = 'moved';

const LIMIT_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_overage_included: 'weekly limit',
  overage: 'extra-usage limit',
};

const WEEKLY_LIMIT_PREFIX = 'seven_day_';

/** A key's model segment as an ID is written with underscores: `vendor-model-2` is `vendor_model_2`. */
const keyOf = (id: string): string => id.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');

/**
 * How a card names the limit a session reported. A model's weekly limit is named after the catalogue's name for
 * the one model its key names, else from the key's words; a limit 10db hasn't seen reads as the usage limit.
 */
export function limitName(limitType: string | null, models: readonly NamedModel[] = []): string {
  if (limitType === null) return 'usage limit';
  const known = LIMIT_NAMES[limitType];
  if (known !== undefined) return known;
  if (!limitType.startsWith(WEEKLY_LIMIT_PREFIX) || limitType === WEEKLY_LIMIT_PREFIX)
    return 'usage limit';
  const tail = limitType.slice(WEEKLY_LIMIT_PREFIX.length);
  const named = models.filter((m) => keyOf(m.id) === tail);
  const [only] = named;
  if (only !== undefined && named.length === 1) return `weekly ${only.name} limit`;
  const words = tail
    .split('_')
    .filter((word) => word !== '')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return `weekly ${words.join(' ')} limit`;
}

/** "is at 96% of its 5-hour limit", or "reached its 5-hour limit" at the limit itself. */
function standing(report: UsageReport, models: readonly NamedModel[]): string {
  const limit = limitName(report.limitType, models);
  if (report.status === 'rejected' || report.utilization === null) return `reached its ${limit}`;
  return `is at ${String(Math.round(report.utilization * 100))}% of its ${limit}`;
}

function usageDetail(report: UsageReport): Record<string, Json> {
  return {
    usage: {
      limitType: report.limitType,
      utilization: report.utilization,
      resetsAt: report.resetsAt?.toISOString() ?? null,
    },
  };
}

/** The project had no usable fallback when it crossed its threshold: the builder picks where it goes. */
export function usageHighCard(
  project: ProjectDto,
  account: AccountRow,
  targets: readonly AccountDto[],
  report: UsageReport,
  models: readonly NamedModel[] = [],
): AccountCard {
  const moves = targets.map((t) => ({ choice: `Move to ${offered(t)}`, accountId: t.id }));
  const only = targets.length === 1 ? targets[0] : undefined;
  const where = only ? only.label : 'another account';
  const resets = report.resetsAt ? ` It resets at ${report.resetsAt.toISOString()}.` : '';
  return {
    title:
      moves.length > 0
        ? `${account.label} ${standing(report, models)}: hand off and move ${project.name} to ${where}?`
        : `${account.label} ${standing(report, models)}`,
    body: `A session on ${account.label} reported that it ${standing(report, models)}.${resets} ${
      moves.length > 0
        ? `Moving asks each lane of ${project.name} on ${account.label} to hand off, then runs its next sessions on the account you pick, and 10db asks whether to move back once the limit resets.`
        : `No other account can take ${project.name} now, so it stays on ${account.label} until the limit.`
    }`,
    foldKey: accountFoldKey(account.id, USAGE_HIGH_CARD),
    detail: detail(account, null, null, null, { moves, ...usageDetail(report) }),
    ...(moves.length > 0
      ? {
          options: [
            ...moves.map((m) => ({
              label: m.choice,
              description: `Hand off and run ${project.name} there`,
            })),
            { label: AccountCardChoice.Later, description: `Stay on ${account.label} for now` },
          ],
        }
      : {}),
  };
}

/** 10db moved the project to its fallback on its own; the card says what and why, and holds no work. */
export function movedCard(
  project: ProjectDto,
  account: AccountRow,
  fallback: AccountDto,
  report: UsageReport,
  models: readonly NamedModel[] = [],
): AccountCard {
  const handedOff =
    report.status === 'rejected' ? '' : ' after asking its running lanes to hand off';
  return {
    title: `${project.name} moved to ${fallback.label}: ${account.label} ${standing(report, models)}`,
    body: `A session on ${account.label} reported that it ${standing(report, models)}. ${project.name} names ${accountDisplayName(fallback)} as its fallback, so 10db moved it there${handedOff}. Each lane's next session runs on ${fallback.label} from its latest handoff; work neither committed nor handed off stays behind. 10db asks whether to move back once ${account.label}'s limit resets.`,
    foldKey: accountFoldKey(account.id, MOVED_CARD),
    detail: detail(account, null, null, null, {
      moves: [{ choice: AccountCardChoice.MoveBack, accountId: account.id }],
      moveBack: true,
      ...usageDetail(report),
    }),
    // The move is done; the builder can undo it, or keep the project where it is and stop the reminder.
    options: [
      {
        label: AccountCardChoice.MoveBack,
        description: `Run ${project.name} on ${accountDisplayName(account)} again`,
      },
      {
        label: AccountCardChoice.Stay,
        description: `Keep ${project.name} on ${accountDisplayName(fallback)}, and don't ask to move it back`,
      },
    ],
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

/** The `detail` key of a cap card; it holds the raise its option offers (`CapRaise`). */
export const CAP_RAISE_DETAIL = 'capRaise';

/** The raise a cap card offers: the account, the answer's label and the cap it sets. */
interface CapRaise {
  readonly accountId: AccountId;
  readonly choice: string;
  readonly toUsd: number;
}

/** A whole-dollar cap, a $10 step clear of what is spent (or of the old cap, if that is higher). */
export function raisedCap(cap: CapStatus): number {
  return Math.ceil((Math.max(cap.capUsd, cap.spentUsd) + 10) / 10) * 10;
}

/**
 * The card's body, option and detail are rewritten as running sessions end, so they show the final
 * overshoot. Raise cap sets the cap it names and lifts the pause; waiting for the month's end needs no answer.
 */
export function capCard(account: AccountRow, cap: CapStatus): AccountCard {
  const over = cap.spentUsd - cap.capUsd;
  const toUsd = raisedCap(cap);
  const choice = `Raise cap to ${money(toUsd).replace('.00', '')}`;
  return {
    title: `${account.label} reached its monthly cap`,
    body: `${money(cap.spentUsd)} of its ${money(cap.capUsd)} cap is spent in ${cap.window.month}${over > 0 ? `, ${money(over)} over` : ''}. New sessions on ${account.label} wait until ${cap.window.end.toISOString()} or until the cap is raised: answer ${choice} to raise it now. Sessions already running finish, and this card shows what they add.`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.MonthlyCap),
    detail: {
      ...detail(account, AccountPauseReason.MonthlyCap, null, null),
      [CAP_RAISE_DETAIL]: { accountId: account.id, choice, toUsd } satisfies CapRaise,
    },
    options: [
      {
        label: choice,
        description: `Set ${account.label}'s monthly cap to ${money(toUsd)} and let its work run`,
      },
    ],
  };
}

/** A refusal names what Claude Code reported in the body and the detail only; never in logs. */
export function refusedCard(account: AccountRow, refusal: AccountRefusal): AccountCard {
  const seen =
    refusal.seenIdentity === null ? '' : ` ${agentOf(account)} reported ${refusal.seenIdentity}.`;
  return {
    title: `${account.label}: sessions refused`,
    body: `${refusal.message}.${seen} ${account.label}'s work waits until the account is fixed. ${fixFor(account, refusal.problem)}`,
    foldKey: accountFoldKey(account.id, AccountPauseReason.Refused, refusal.problem),
    detail: detail(account, AccountPauseReason.Refused, refusal.problem, refusal.seenIdentity),
    options: [
      ...(signsInWithLogin(account.kind) && refusal.seenIdentity !== null
        ? [
            {
              label: AccountCardChoice.Confirm,
              description: `Run ${account.label} as ${refusal.seenIdentity} from now on`,
            },
          ]
        : []),
      { label: AccountCardChoice.Resume, description: 'I fixed it: try the account again' },
      {
        label: AccountCardChoice.Later,
        description: `Keep its work waiting. Resume ${account.label} later from Settings › Accounts`,
      },
    ],
  };
}

/**
 * For an account on its own directory: the builder confirms the identity the agent reported (spec
 * §5), a subscription's email, or a ChatGPT plan's email and workspace together.
 */
export function confirmCard(account: AccountRow, email: string): AccountCard {
  const reported =
    account.kind === AccountKind.CodexSignin ? 'this email and workspace' : 'this email';
  return {
    title: `Confirm the account ${account.label}`,
    body: `${agentOf(account)} in ${account.configDir ?? `${agentOf(account)}'s default directory`} is signed in as ${email}. Confirm it, and ${account.label}'s sessions run only while they report ${reported}.`,
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
      ? `${agentOf(account)} is not signed in for ${account.label}`
      : `${why}, so ${account.label} may be signed out`;
  return {
    title: `Sign in the account ${account.label}`,
    body: `${seen}. Its work waits; 10db tries again in a minute. Sign in with: ${signInCommandFor(account)}, then answer Check again to try now.`,
    foldKey: accountFoldKey(account.id, AccountProblem.SignedOut),
    detail: detail(account, null, AccountProblem.SignedOut, null),
    options: [checkAgain(account)],
  };
}

/** Probe the account now instead of at the next minute; what the cards that wait for a fix answer. */
const checkAgain = (account: AccountRow): InboxOption => ({
  label: AccountCardChoice.CheckAgain,
  description: `I fixed it: look at ${account.label} again now`,
});

/**
 * The default account's identity is recorded from its first probe without a Confirm (it is the builder's current
 * login), so this card says which login that was. It holds no work.
 */
export function recordedCard(account: AccountRow, email: string): AccountCard {
  return {
    title: `${account.label} runs as ${email}`,
    body: `10db recorded ${email}, the login in ${account.configDir ?? "Claude Code's default directory"}, as ${account.label}'s identity, and runs its sessions only while they report it. If that is the wrong login, sign in as the right one with: ${signInCommand(account.configDir)}, then answer Record again: 10db forgets ${email} and records the login the directory holds now.`,
    foldKey: accountFoldKey(account.id, 'recorded'),
    detail: detail(account, null, null, email),
    options: [
      {
        label: AccountCardChoice.RecordAgain,
        description: `Forget ${email} and record the login ${account.label} runs as now`,
      },
    ],
  };
}

export function secretCard(account: AccountRow): AccountCard {
  return {
    title: `Set the secret of ${account.label}`,
    body: `${account.label} has no secret yet, so its work waits. ${fixFor(account, AccountProblem.SecretMissing)}`,
    foldKey: accountFoldKey(account.id, AccountProblem.SecretMissing),
    detail: detail(account, null, AccountProblem.SecretMissing, null),
    options: [checkAgain(account)],
  };
}

/** A first-party directory that reports credentials a subscription can't run on; signing in doesn't change that. */
export function credentialsCard(account: AccountRow, refusal: AccountRefusal): AccountCard {
  return {
    title: `Fix the credentials of ${account.label}`,
    body: `${refusal.message}. ${account.label}'s work waits; 10db tries again in a minute. ${fixFor(account, AccountProblem.WrongCredentials)}`,
    foldKey: accountFoldKey(account.id, AccountProblem.WrongCredentials),
    detail: detail(account, null, AccountProblem.WrongCredentials, null),
    options: [checkAgain(account)],
  };
}
