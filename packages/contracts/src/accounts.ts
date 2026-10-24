import { z } from 'zod';
import { AccountId, ProjectId } from './ids';

type ValueOf<T> = T[keyof T];

/** Who pays for a project's sessions (accounts spec §4). The Codex kinds are reserved until the Codex adapter exists. */
export const AccountKind = {
  ClaudeSubscription: 'claude_subscription',
  AnthropicApiKey: 'anthropic_api_key',
  Bedrock: 'bedrock',
  Gateway: 'gateway',
  OpenaiApiKey: 'openai_api_key',
  CodexSignin: 'codex_signin',
} as const;
export type AccountKind = ValueOf<typeof AccountKind>;

/** The kinds 10db can run a session on today. */
export const SUPPORTED_ACCOUNT_KINDS = [
  AccountKind.ClaudeSubscription,
  AccountKind.AnthropicApiKey,
  AccountKind.Bedrock,
  AccountKind.Gateway,
] as const;
export type SupportedAccountKind = (typeof SUPPORTED_ACCOUNT_KINDS)[number];

const METERED: readonly AccountKind[] = [
  AccountKind.AnthropicApiKey,
  AccountKind.Bedrock,
  AccountKind.Gateway,
];

/** Billed per token: the SDK's dollars are real, and a monthly cap applies. */
export function isMetered(kind: AccountKind): boolean {
  return METERED.includes(kind);
}

/** Why a session on an account was refused, or why the account can't start one yet. */
export const AccountProblem = {
  Unconfirmed: 'unconfirmed',
  IdentityMismatch: 'identity_mismatch',
  WrongCredentials: 'wrong_credentials',
  SignedOut: 'signed_out',
  SecretMissing: 'secret_missing',
  SecretChanged: 'secret_changed',
  CannotBill: 'cannot_bill',
} as const;
export type AccountProblem = ValueOf<typeof AccountProblem>;

/** Why an account's lanes are paused. */
export const AccountPauseReason = {
  UsageLimit: 'usage_limit',
  MonthlyCap: 'monthly_cap',
  Refused: 'refused',
} as const;
export type AccountPauseReason = ValueOf<typeof AccountPauseReason>;

export const DEFAULT_ACCOUNT_LANE_CAP = 4;
/** The seeded account's label: what it is, the builder's Claude plan. Who pays for it is `payer`. */
export const DEFAULT_ACCOUNT_LABEL = 'Claude plan';

/** How pickers and card options name an account: its label, and its recorded identity beside it. */
export function accountDisplayName(account: {
  readonly label: string;
  readonly expectedIdentity: string | null;
}): string {
  return account.expectedIdentity === null
    ? account.label
    : `${account.label} · ${account.expectedIdentity}`;
}
const MAX_ACCOUNT_LANES = 16;
const MAX_MONTHLY_CAP_USD = 1_000_000;

/**
 * A Claude Code model alias as the router names profiles: `opus`, `sonnet`, `haiku`, `fable`. A model ID
 * never matches it, which is how the model check tells a requested alias from a mapped ID.
 */
export const MODEL_ALIAS_PATTERN = /^[a-z]+$/;
const Alias = z.string().regex(MODEL_ALIAS_PATTERN, 'a lowercase model alias');
const modelChoice = {
  /** The channel's model ID per alias, sent through the SDK's `model` option instead of the alias. */
  modelMap: z.record(Alias, z.string().trim().min(1).max(200)).optional(),
  /** The aliases the account offers; the router considers only these. Absent means every alias. */
  aliases: z.array(Alias).min(1).optional(),
};
const AwsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'an AWS region such as us-west-2');
const AwsProfile = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'an AWS profile name');
/** A gateway's endpoint. Credentials in it would land in the database, so it may carry none. */
const BaseUrl = z.url({ protocol: /^https$/ }).refine(
  (url) => {
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '' && parsed.search === '';
  },
  { message: 'an https URL with no credentials and no query' },
);

export const SubscriptionSettings = z.strictObject({ ...modelChoice });
export const ApiKeySettings = z.strictObject({ ...modelChoice });
export const BedrockSettings = z.strictObject({
  ...modelChoice,
  region: AwsRegion,
  /** The AWS profile the session uses; null means a bearer token from the Keychain. */
  awsProfile: AwsProfile.nullable(),
});
export const GatewaySettings = z.strictObject({ ...modelChoice, baseUrl: BaseUrl });
export type SubscriptionSettings = z.infer<typeof SubscriptionSettings>;
export type ApiKeySettings = z.infer<typeof ApiKeySettings>;
export type BedrockSettings = z.infer<typeof BedrockSettings>;
export type GatewaySettings = z.infer<typeof GatewaySettings>;

export const AccountSettings = z.union([BedrockSettings, GatewaySettings, SubscriptionSettings]);
export type AccountSettings = z.infer<typeof AccountSettings>;

const SETTINGS_BY_KIND = {
  [AccountKind.ClaudeSubscription]: SubscriptionSettings,
  [AccountKind.AnthropicApiKey]: ApiKeySettings,
  [AccountKind.Bedrock]: BedrockSettings,
  [AccountKind.Gateway]: GatewaySettings,
} as const satisfies Record<SupportedAccountKind, z.ZodType>;

/** Stored or submitted settings, checked against the account's own kind. */
export function parseAccountSettings(kind: SupportedAccountKind, raw: unknown): AccountSettings {
  return SETTINGS_BY_KIND[kind].parse(raw);
}

/** Whether the account's credential is a Keychain secret: an API key, a gateway token or a Bedrock bearer token. */
export function needsSecret(kind: SupportedAccountKind, settings: AccountSettings): boolean {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
      return false;
    case AccountKind.AnthropicApiKey:
    case AccountKind.Gateway:
      return true;
    case AccountKind.Bedrock:
      return 'awsProfile' in settings && settings.awsProfile === null;
  }
}

const Label = z.string().trim().min(1).max(80);
const Payer = z.string().trim().max(200);
const LaneCap = z.int().min(1).max(MAX_ACCOUNT_LANES);
const MonthlyCapUsd = z.number().positive().max(MAX_MONTHLY_CAP_USD);
/** An organization `accountInfo()` reports for a keyed account (spec §11: unverified for API keys and Bedrock). */
const Organization = z.string().trim().min(1).max(200);
const Timestamp = z.iso.datetime();

const common = {
  label: Label,
  payer: Payer.default(''),
  laneCap: LaneCap.default(DEFAULT_ACCOUNT_LANE_CAP),
};
const metered = { monthlyCapUsd: MonthlyCapUsd.nullable().default(null) };
const organization = { expectedIdentity: Organization.nullable().default(null) };

/**
 * `POST /accounts`. A subscription's identity is confirmed after it signs in, so it takes none here;
 * a gateway is identified by its key's fingerprint, so it never takes one.
 */
export const AccountInput = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal(AccountKind.ClaudeSubscription),
      ...common,
      settings: SubscriptionSettings.default({}),
    }),
    z.strictObject({
      kind: z.literal(AccountKind.AnthropicApiKey),
      ...common,
      ...metered,
      ...organization,
      settings: ApiKeySettings.default({}),
    }),
    z.strictObject({
      kind: z.literal(AccountKind.Bedrock),
      ...common,
      ...metered,
      ...organization,
      settings: BedrockSettings,
    }),
    z.strictObject({
      kind: z.literal(AccountKind.Gateway),
      ...common,
      ...metered,
      settings: GatewaySettings,
    }),
  ],
  {
    error:
      'Choose claude_subscription, anthropic_api_key, bedrock or gateway; openai_api_key and codex_signin are reserved until the Codex adapter exists',
  },
);
export type AccountInput = z.input<typeof AccountInput>;
export type AccountConfig = z.output<typeof AccountInput>;

/** `PATCH /accounts/:id`. The kind never changes; settings and identity are checked against it by the daemon. */
export const AccountPatch = z
  .strictObject({
    label: Label,
    payer: Payer,
    laneCap: LaneCap,
    monthlyCapUsd: MonthlyCapUsd.nullable(),
    /** The email (subscription) or organization (API key, Bedrock) a session must report; null clears it. */
    expectedIdentity: z.string().trim().min(1).max(200).nullable(),
    /** The kind's whole settings object. */
    settings: z.record(z.string(), z.json()),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type AccountPatch = z.infer<typeof AccountPatch>;

export const AccountDto = z.object({
  id: AccountId,
  kind: z.enum(SUPPORTED_ACCOUNT_KINDS),
  label: z.string(),
  payer: z.string(),
  expectedIdentity: z.string().nullable(),
  /**
   * The Claude Code config directory its sessions run on: 10db's own directory for every account but
   * the default account, which runs on the builder's login (null is Claude Code's default directory).
   */
  configDir: z.string().nullable(),
  settings: AccountSettings,
  laneCap: z.int(),
  monthlyCapUsd: z.number().nullable(),
  archived: z.boolean(),
  /** New projects bind to it when they name no account. */
  isDefault: z.boolean(),
  /** Whether 10db has recorded a secret for it. The secret itself never leaves the daemon. */
  secretSet: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AccountDto = z.infer<typeof AccountDto>;

/** How to sign a subscription account in with the unmodified `claude` (spec §5). */
export const AccountSignInDto = z.object({
  accountId: AccountId,
  configDir: z.string().nullable(),
  command: z.string(),
});
export type AccountSignInDto = z.infer<typeof AccountSignInDto>;

/** `POST /accounts`: the account, and its sign-in steps when it is a subscription. */
export const AccountCreatedDto = z.object({
  account: AccountDto,
  signIn: AccountSignInDto.nullable(),
});
export type AccountCreatedDto = z.infer<typeof AccountCreatedDto>;

/** The characters a secret may hold: printable ASCII except space, double quote and backslash. */
export const SECRET_CHARACTERS = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * `PUT /accounts/:id/secret`. The secret reaches the Keychain inside double quotes on `security`'s
 * standard input, so it may hold no whitespace, quote or backslash.
 */
export const AccountSecretInput = z.strictObject({
  secret: z
    .string()
    .min(8)
    .max(8192)
    .regex(SECRET_CHARACTERS, 'printable ASCII with no spaces, double quotes or backslashes'),
});
export type AccountSecretInput = z.infer<typeof AccountSecretInput>;

/** Why a session on an account was refused. `seenIdentity` is what Claude Code reported, when it matters. */
export const AccountRefusal = z.object({
  problem: z.enum(AccountProblem),
  /** Names the account and what differed; never an email, organization or secret. */
  message: z.string(),
  seenIdentity: z.string().nullable(),
});
export type AccountRefusal = z.infer<typeof AccountRefusal>;

/** `GET /accounts/:id/identity`: what Claude Code reports for the account now, and the refusal a session would meet. */
export const AccountIdentityDto = z.object({
  accountId: AccountId,
  email: z.string().nullable(),
  organization: z.string().nullable(),
  apiProvider: z.string().nullable(),
  apiKeySource: z.string().nullable(),
  tokenSource: z.string().nullable(),
  /** Whether it reported a subscription plan; the plan's name is never compared or shown. */
  subscription: z.boolean(),
  refusal: AccountRefusal.nullable(),
});
export type AccountIdentityDto = z.infer<typeof AccountIdentityDto>;

export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month as YYYY-MM');

/** Tokens and dollars over some sessions. `costUsd` is null for a subscription. */
export const UsageTotals = z.object({
  tokensIn: z.int().min(0),
  tokensOut: z.int().min(0),
  tokensCached: z.int().min(0),
  costUsd: z.number().min(0).nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** `GET /accounts/:id/usage?month=YYYY-MM`: the month's sessions on the account, in total and per project. */
export const AccountUsageDto = z.object({
  accountId: AccountId,
  month: Month,
  total: UsageTotals,
  monthlyCapUsd: z.number().nullable(),
  byProject: z.array(UsageTotals.extend({ projectId: ProjectId, projectName: z.string() })),
});
export type AccountUsageDto = z.infer<typeof AccountUsageDto>;

/** The `detail` key of a card about an account. */
export const ACCOUNT_CARD_DETAIL = 'accountCard';

export const AccountCardDetail = z.object({
  accountId: AccountId,
  reason: z.enum(AccountPauseReason).nullable(),
  problem: z.enum(AccountProblem).nullable(),
  /** The identity a Confirm answer would record. */
  seenIdentity: z.string().nullable(),
});
export type AccountCardDetail = z.infer<typeof AccountCardDetail>;

/** The options on an account card: confirm a seen identity, try the account again after a fix, or wait. */
export const AccountCardChoice = { Confirm: 'Confirm', Resume: 'Resume', Later: 'Later' } as const;
export type AccountCardChoice = ValueOf<typeof AccountCardChoice>;
