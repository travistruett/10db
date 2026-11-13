import { z } from 'zod';
import { isSignInUrl } from './sign-in-url';

/**
 * What 10db can tell of the GitHub CLI's login: gh is not installed where 10db looks, gh is signed
 * out, gh is signed in, or the state could not be read (no network). An unreadable state is never
 * reported as signed out. No switch turns GitHub off, so there is no off state.
 */
export const GithubState = {
  NotInstalled: 'not_installed',
  SignedOut: 'signed_out',
  SignedIn: 'signed_in',
  Unreachable: 'unreachable',
} as const;
export type GithubState = (typeof GithubState)[keyof typeof GithubState];

/** The longest message a sign-in's end or a refused start carries. */
export const GITHUB_LOGIN_MESSAGE_MAX = 200;

const DevicePage = z.string().refine(isSignInUrl, { message: 'not a sign-in page 10db opens' });

/** The one-time code and the page to enter it on, which gh prints when a sign-in starts. */
export const GithubSigninDto = z.object({
  code: z.string().min(1),
  url: DevicePage,
});
export type GithubSigninDto = z.infer<typeof GithubSigninDto>;

/**
 * `GET /github`: the login gh holds and, while a Sign In waits for the builder, its code and page, so a
 * screen mounted mid-sign-in shows them again.
 */
export const GithubStatusDto = z.object({
  state: z.enum(GithubState),
  login: z.string().nullable(),
  checkedAt: z.iso.datetime(),
  signingIn: GithubSigninDto.extend({ startedAt: z.iso.datetime() }).nullable(),
});
export type GithubStatusDto = z.infer<typeof GithubStatusDto>;

/**
 * What a `github.login_ended` event carries: whether the sign-in finished, the login gh now holds when
 * it did, a message safe to show that is never more than `GITHUB_LOGIN_MESSAGE_MAX` characters, and
 * whether the builder asked for the end (a cancel is not an error).
 */
export const GithubLoginEndedData = z.object({
  ok: z.boolean(),
  login: z.string().nullable(),
  message: z.string().max(GITHUB_LOGIN_MESSAGE_MAX).nullable(),
  cancelled: z.boolean(),
});
export type GithubLoginEndedData = z.infer<typeof GithubLoginEndedData>;

/**
 * The `detail` key of an Inbox card that sends the builder to a card in Settings › Integrations: its value
 * is that card's `?focus=` name (`github`). The desktop offers Open Integrations for it.
 */
export const OPEN_INTEGRATIONS_DETAIL = 'openIntegrations';
