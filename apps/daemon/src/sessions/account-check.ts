import {
  AccountKind,
  AccountProblem,
  MODEL_ALIAS_PATTERN,
  type AccountRefusal,
  type SupportedAccountKind,
} from '@10db/contracts';
import type { AccountExpectation } from '../environment';

/** What Claude Code reports about the account a session runs on (`accountInfo()`). */
export interface SeenAccount {
  readonly email: string | undefined;
  readonly organization: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly apiProvider: string | undefined;
}

export function seenFrom(info: {
  readonly email?: string;
  readonly organization?: string;
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
  readonly apiProvider?: string;
}): SeenAccount {
  return {
    email: info.email,
    organization: info.organization,
    subscriptionType: info.subscriptionType,
    tokenSource: info.tokenSource,
    apiKeySource: info.apiKeySource,
    apiProvider: info.apiProvider,
  };
}

const NEEDS: Readonly<Record<SupportedAccountKind, string>> = {
  [AccountKind.ClaudeSubscription]: 'a Claude subscription',
  [AccountKind.AnthropicApiKey]: 'an Anthropic API key',
  [AccountKind.Bedrock]: 'Bedrock',
  [AccountKind.Gateway]: 'a gateway token',
};

const noKey = (source: string | undefined): boolean => source === undefined || source === 'none';

/** Key sources and providers only: never an email or organization, so it can be logged. */
function described(seen: SeenAccount): string {
  return `apiKeySource ${seen.apiKeySource ?? 'unreported'}, apiProvider ${seen.apiProvider ?? 'unreported'}, tokenSource ${seen.tokenSource ?? 'unreported'}, subscription ${seen.subscriptionType ? 'yes' : 'no'}`;
}

/**
 * Whether Claude Code bills the credential the kind needs. Only values a real session has shown are
 * accepted (spike 12 for the gateway), so a renamed variable fails loudly instead of billing someone else.
 */
function credentialsMatch(kind: SupportedAccountKind, seen: SeenAccount): boolean {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
      // A plan's name is never compared; a gateway also looks first-party, so its token source rules it out.
      return (
        noKey(seen.apiKeySource) &&
        seen.apiProvider === 'firstParty' &&
        Boolean(seen.subscriptionType) &&
        seen.tokenSource !== 'ANTHROPIC_AUTH_TOKEN'
      );
    case AccountKind.AnthropicApiKey:
      return seen.apiKeySource === 'ANTHROPIC_API_KEY' && seen.apiProvider === 'firstParty';
    case AccountKind.Bedrock:
      return seen.apiProvider === 'bedrock';
    case AccountKind.Gateway:
      return (
        seen.tokenSource === 'ANTHROPIC_AUTH_TOKEN' &&
        seen.apiProvider === 'firstParty' &&
        noKey(seen.apiKeySource)
      );
  }
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Before the prompt (accounts spec §5): who Claude Code is, and the credential it bills. */
export function checkAccount(expect: AccountExpectation, seen: SeenAccount): AccountRefusal | null {
  const who = `account "${expect.label}"`;
  if (
    expect.kind === AccountKind.ClaudeSubscription &&
    !seen.email &&
    !seen.subscriptionType &&
    noKey(seen.apiKeySource)
  )
    return {
      problem: AccountProblem.SignedOut,
      message: `Claude Code is not signed in for ${who}`,
      seenIdentity: null,
    };
  if (!credentialsMatch(expect.kind, seen))
    return {
      problem: AccountProblem.WrongCredentials,
      message: `${who} needs ${NEEDS[expect.kind]} but Claude Code reported ${described(seen)}`,
      seenIdentity: null,
    };
  if (expect.identity === null) return null;
  const subscription = expect.kind === AccountKind.ClaudeSubscription;
  const reported = subscription ? seen.email : seen.organization;
  if (reported !== undefined && same(reported, expect.identity)) return null;
  return {
    problem: AccountProblem.IdentityMismatch,
    message: `Claude Code reported a different ${subscription ? 'email' : 'organization'} than the one confirmed for ${who}`,
    seenIdentity: reported ?? null,
  };
}

/**
 * `accountInfo()` rejected or never answered. A signed-out config directory may report nothing at all,
 * so on a subscription that reads as signed out and the account waits for its sign-in; a keyed account
 * has no such reason, and null leaves its workstream to fail.
 */
export function missingAccountRefusal(
  expect: AccountExpectation,
  why: string,
): AccountRefusal | null {
  return expect.kind === AccountKind.ClaudeSubscription
    ? {
        problem: AccountProblem.SignedOut,
        message: `${why} for account "${expect.label}", which looks signed out`,
        seenIdentity: null,
      }
    : null;
}

/** At the first init: the key source the CLI actually used, with the provider and plan the preflight saw. */
export function checkInitCredentials(
  expect: AccountExpectation,
  apiKeySource: string | undefined,
  preflight: SeenAccount,
): AccountRefusal | null {
  const seen = { ...preflight, apiKeySource };
  return credentialsMatch(expect.kind, seen)
    ? null
    : {
        problem: AccountProblem.WrongCredentials,
        message: `account "${expect.label}" needs ${NEEDS[expect.kind]} but Claude Code started with ${described(seen)}`,
        seenIdentity: null,
      };
}

/** An alias matches the model ID Claude Code resolved it to; a model-map ID must come back unchanged. */
export function modelMatches(requested: string, reported: string): boolean {
  if (requested === reported) return true;
  return (
    MODEL_ALIAS_PATTERN.test(requested) && reported.toLowerCase().includes(`claude-${requested}`)
  );
}

const CREDENTIAL_ERRORS: Readonly<Record<string, AccountProblem>> = {
  authentication_failed: AccountProblem.SignedOut,
  oauth_org_not_allowed: AccountProblem.SignedOut,
  cloud_credential_error: AccountProblem.SignedOut,
  billing_error: AccountProblem.CannotBill,
  account_on_hold: AccountProblem.CannotBill,
};

/** An assistant error that is the account's, not the work's. */
export function credentialProblem(error: string | undefined): AccountProblem | null {
  return error === undefined ? null : (CREDENTIAL_ERRORS[error] ?? null);
}
