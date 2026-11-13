import {
  AccountKind,
  AccountProblem,
  ModelMarkBasis,
  signsInWithLogin,
  type AccountRefusal,
  type Effort,
  type AgentAccountKind,
} from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { SignInState } from './sign-in-check';

/** A model an account lists. */
export interface SeenModel {
  /** What the account calls it, without a context-window suffix. */
  readonly id: string;
  /** The concrete model an alias stands for; null when the account reports none. */
  readonly resolvedId: string | null;
  /** The efforts it reports that 10db knows; empty when it reports none. */
  readonly efforts: readonly Effort[];
}

/** What Claude Code reports about the account a session runs on (`accountInfo()`). */
export interface SeenAccount {
  readonly email: string | undefined;
  readonly organization: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly apiProvider: string | undefined;
  /** The models the account lists, when the agent could list them; absent when it could not. */
  readonly models?: readonly SeenModel[];
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

const NEEDS: Readonly<Record<AgentAccountKind, string>> = {
  [AccountKind.ClaudeSubscription]: 'a Claude subscription',
  [AccountKind.AnthropicApiKey]: 'an Anthropic API key',
  [AccountKind.Bedrock]: 'Bedrock',
  [AccountKind.Gateway]: 'a gateway token',
  [AccountKind.CodexSignin]: 'a ChatGPT sign-in',
};

/** The tool a kind's sessions run on, and its own sign-in status command, so a card names the right one. */
const TOOL: Readonly<Record<AgentAccountKind, { name: string; status: string }>> = {
  [AccountKind.ClaudeSubscription]: { name: 'Claude Code', status: 'claude auth status' },
  [AccountKind.AnthropicApiKey]: { name: 'Claude Code', status: 'claude auth status' },
  [AccountKind.Bedrock]: { name: 'Claude Code', status: 'claude auth status' },
  [AccountKind.Gateway]: { name: 'Claude Code', status: 'claude auth status' },
  [AccountKind.CodexSignin]: { name: 'Codex', status: 'codex login status' },
};

/** A ChatGPT account's identity: the email and the workspace, since one email can sign in to several. */
export function codexIdentity(email: string, workspace: string): string {
  return `${email} · ${workspace}`;
}

const noKey = (source: string | undefined): boolean => source === undefined || source === 'none';

/** Key sources and providers only: never an email or organization, so it can be logged. */
function described(seen: SeenAccount): string {
  return `apiKeySource ${seen.apiKeySource ?? 'unreported'}, apiProvider ${seen.apiProvider ?? 'unreported'}, tokenSource ${seen.tokenSource ?? 'unreported'}, subscription ${seen.subscriptionType ? 'yes' : 'no'}`;
}

/**
 * Whether Claude Code bills the credential the kind needs. Only values a real session has shown are
 * accepted (spike 12 for the gateway), so a renamed variable fails loudly instead of billing someone else.
 */
function credentialsMatch(kind: AgentAccountKind, seen: SeenAccount): boolean {
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
    case AccountKind.CodexSignin:
      return seen.apiProvider === 'chatgpt' && Boolean(seen.subscriptionType);
  }
}

/** The email and workspace a ChatGPT sign-in reported; the email alone when it reported no workspace. */
function chatgptIdentity(seen: SeenAccount): string | undefined {
  if (seen.email === undefined) return undefined;
  return seen.organization === undefined
    ? seen.email
    : codexIdentity(seen.email, seen.organization);
}

/** What a login account is confirmed as: a ChatGPT plan's email and workspace, a subscription's email. */
export function loginIdentity(kind: AgentAccountKind, seen: SeenAccount): string | undefined {
  return kind === AccountKind.CodexSignin ? chatgptIdentity(seen) : seen.email;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Before the prompt (accounts spec §5): who the agent is, and the credential it bills. */
export function checkAccount(expect: AccountExpectation, seen: SeenAccount): AccountRefusal | null {
  const who = `account "${expect.label}"`;
  // A third-party provider or a gateway token reports no email or plan either, and signing in cannot fix
  // that: only a first-party report with nothing in it is a signed-out directory.
  const tool = TOOL[expect.kind].name;
  const codex = expect.kind === AccountKind.CodexSignin;
  const providerOfLogin = codex ? 'chatgpt' : 'firstParty';
  const firstParty = seen.apiProvider === undefined || seen.apiProvider === providerOfLogin;
  if (
    signsInWithLogin(expect.kind) &&
    firstParty &&
    seen.tokenSource !== 'ANTHROPIC_AUTH_TOKEN' &&
    !seen.email &&
    !seen.subscriptionType &&
    noKey(seen.apiKeySource)
  )
    return {
      problem: AccountProblem.SignedOut,
      message: `${tool} is not signed in for ${who}`,
      seenIdentity: null,
    };
  if (!credentialsMatch(expect.kind, seen))
    return {
      problem: AccountProblem.WrongCredentials,
      message: `${who} needs ${NEEDS[expect.kind]} but ${tool} reported ${described(seen)}`,
      seenIdentity: null,
    };
  if (expect.identity === null) return null;
  const login = signsInWithLogin(expect.kind);
  const reported = codex ? chatgptIdentity(seen) : login ? seen.email : seen.organization;
  if (reported !== undefined && same(reported, expect.identity)) return null;
  const what = codex ? 'ChatGPT sign-in' : login ? 'email' : 'organization';
  return {
    problem: AccountProblem.IdentityMismatch,
    message: `${tool} reported a different ${what} than the one confirmed for ${who}`,
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
  printed?: string,
  signIn?: SignInState,
): AccountRefusal | null {
  if (!signsInWithLogin(expect.kind)) return null;
  const { status } = TOOL[expect.kind];
  const tail = printed ? `. ${printed}` : '';
  const who = `${why} for account "${expect.label}"`;
  // The tool's status command settles it: only "not signed in" is a sign-out. Anything else is a slow start.
  if (signIn === 'signed_in' || signIn === 'unknown')
    return {
      problem: AccountProblem.StartTimeout,
      message: `${who}, but ${
        signIn === 'signed_in' ? `${status} says it is signed in` : `${status} gave no answer`
      }, so its starts kept timing out${tail}`,
      seenIdentity: null,
    };
  return {
    problem: AccountProblem.SignedOut,
    message:
      signIn === 'signed_out'
        ? `${who}, and ${status} says it is not signed in, so it looks signed out${tail}`
        : `${who}, which looks signed out${tail}`,
    seenIdentity: null,
  };
}

/** How much of what Claude Code printed a card quotes: the end, where the cause usually is. */
const PRINTED_CHARS = 300;

/** One line of what a start printed on stderr: no colour codes or control characters, the end of it. */
function oneLine(raw: string): string {
  const text = raw
    // eslint-disable-next-line no-control-regex -- the point is to remove the escape character
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return text.length > PRINTED_CHARS ? `…${text.slice(-PRINTED_CHARS).trimStart()}` : text;
}

/**
 * What a session start that got no account from Claude Code says: how long it waited, how many starts
 * got nothing, and what they printed, so the builder can tell a slow start from a real sign-out.
 * `printed` holds one entry per start, the text its stderr held; `kind` picks the tool the text names.
 */
export function noAccountWhy(
  waitMs: number | readonly number[],
  printed: readonly string[],
  kind: AgentAccountKind,
): { readonly why: string; readonly printed: string } {
  const starts = printed.length;
  const waits = typeof waitMs === 'number' ? [waitMs] : [...new Set(waitMs)];
  const seconds = waits.map((ms) => `${String(ms / 1_000)} s`);
  const last = seconds.pop();
  const tool = TOOL[kind].name;
  const said = `${tool} reported no account`;
  const wait =
    seconds.length === 0
      ? `${said} within ${last ?? '0 s'}`
      : `${said} on each of ${String(starts)} starts (waiting ${seconds.join(', ')} and ${last ?? ''})`;
  const seen = [...new Set(printed.map(oneLine).filter((line) => line !== ''))];
  return {
    why: starts > 1 && seconds.length === 0 ? `${wait} on each of ${String(starts)} starts` : wait,
    printed:
      seen.length === 0
        ? `${tool} printed nothing`
        : `${tool} printed: ${seen.map((line) => `"${line}"`).join('; ')}`,
  };
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
        message: `account "${expect.label}" needs ${NEEDS[expect.kind]} but ${TOOL[expect.kind].name} started with ${described(seen)}`,
        seenIdentity: null,
      };
}

/** The suffix that asks Claude Code for the 1M context window; a subscription's `init.model` leaves it off. */
const CONTEXT_SUFFIX = /\[1m\]$/;

/** The model a session reports is the one launched, up to the context suffix a subscription drops. */
export function modelMatches(launched: string, reported: string): boolean {
  return launched.replace(CONTEXT_SUFFIX, '') === reported.replace(CONTEXT_SUFFIX, '');
}

/** The assistant error Claude Code reports for a model the account cannot run. */
export const MODEL_NOT_FOUND_ERROR = 'model_not_found';

const CREDENTIAL_ERRORS: Readonly<Record<string, AccountProblem>> = {
  authentication_failed: AccountProblem.SignedOut,
  oauth_org_not_allowed: AccountProblem.SignedOut,
  cloud_credential_error: AccountProblem.SignedOut,
  billing_error: AccountProblem.CannotBill,
  account_on_hold: AccountProblem.CannotBill,
};

/** What an error says when it reports that a model is missing or off limits to the account. */
const MODEL_UNAVAILABLE =
  /not found|does not exist|doesn['’]t exist|no access|(?:don['’]t|do not) have access|not authorized|access denied|accessdenied|unknown model/i;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "is not supported", "is currently not available" and the like. */
const UNSUPPORTED = `(?:is\\s+(?:currently\\s+)?not|isn['’]t|not)\\s+(?:currently\\s+)?(?:supported|available)`;

/** How far, within one clause, the phrase may follow the model: bounded, so a long text is read in linear time. */
const CLAUSE_REACH = 160;

/**
 * Whether `text` says the model is not supported or not available: the phrase follows the model's ID, or the word
 * model, in the same clause. It may come wrapped as Claude Code sends it ("API Error: 400 Model X is not
 * available", or a JSON body's "message"). A config error that puts the phrase first ("thinking.budget is not
 * supported for model X") never counts. One that names the model first ("Tool use with model X is not supported")
 * still does: telling those apart needs more than the wording, so such a mark is on probation (`modelRefusalBasis`).
 */
function saysModelUnsupported(text: string, id: string): boolean {
  return new RegExp(
    `(?:${escapeRegExp(id)}|\\bmodel\\b)[^.;:]{0,${String(CLAUSE_REACH)}}?\\b${UNSUPPORTED}`,
    'i',
  ).test(text);
}

/** Whether `text` names `id` as a whole token, so `<model>` is not found in `<model>-<suffix>`. */
function namesToken(text: string, id: string): boolean {
  // A model ID continues through letters, digits, `-`, `_`, `:`, `/` and a `.` that a character follows.
  return new RegExp(`(?<![\\w.:/-])${escapeRegExp(id)}(?![\\w:/-]|\\.\\w)`).test(text);
}

/**
 * Whether an assistant error at a session's first reply means the account cannot run the model it was launched on,
 * and what the answer rests on. Claude Code names that case `model_not_found`: `error`, final. A gateway or Bedrock
 * may report it as an invalid request or an unknown error instead, so those count only when the text names the
 * launched model ID as a whole token and says the model is missing or off limits: `wording`, which cannot tell a
 * config error that names the model first ("Tool use with model X is not supported") from a real refusal ("Model X
 * is not available in this region"), so such a mark ends on its own (`ModelMarkBasis`). Every other error (a server
 * error, an overload, a rate limit, a credential or billing error) never counts, whatever it quotes.
 */
export function modelRefusalBasis(
  error: string | undefined,
  text: string,
  launched: string,
): ModelMarkBasis | null {
  if (error === MODEL_NOT_FOUND_ERROR) return ModelMarkBasis.Error;
  if (error !== 'invalid_request' && error !== 'unknown') return null;
  const id = launched.replace(CONTEXT_SUFFIX, '');
  return namesToken(text, id) && (MODEL_UNAVAILABLE.test(text) || saysModelUnsupported(text, id))
    ? ModelMarkBasis.Wording
    : null;
}

/** Whether an assistant error at a session's first reply means the account cannot run the model (see `modelRefusalBasis`). */
export function isModelRefusal(error: string | undefined, text: string, launched: string): boolean {
  return modelRefusalBasis(error, text, launched) !== null;
}

/** An assistant error that is the account's, not the work's. */
export function credentialProblem(error: string | undefined): AccountProblem | null {
  return error === undefined ? null : (CREDENTIAL_ERRORS[error] ?? null);
}
