import {
  AccountIdentityDto,
  AccountPauseDto,
  AccountSignInDto,
  AccountUsageDto,
  mintId,
  AccountDto,
} from '@10db/contracts';

const AT = '2026-10-13T12:00:00.000Z';

export function accountDto(overrides: Partial<AccountDto> = {}): AccountDto {
  return AccountDto.parse({
    id: mintId('Account'),
    kind: 'claude_subscription',
    label: 'Company A',
    payer: '',
    expectedIdentity: null,
    configDir: '/data/accounts/a/claude',
    settings: {},
    laneCap: 4,
    monthlyCapUsd: null,
    archived: false,
    isDefault: false,
    secretSet: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** The account a fresh daemon seeds; the base handlers serve it. */
export const DEFAULT_ACCOUNT = accountDto({
  label: 'Claude plan',
  expectedIdentity: 'builder@example.com',
  configDir: null,
  isDefault: true,
});

export function accountUsageDto(overrides: Partial<AccountUsageDto> = {}): AccountUsageDto {
  return AccountUsageDto.parse({
    accountId: DEFAULT_ACCOUNT.id,
    month: '2026-10',
    total: { tokensIn: 1200, tokensOut: 800, tokensCached: 400, costUsd: null },
    monthlyCapUsd: null,
    byProject: [],
    ...overrides,
  });
}

export function accountIdentityDto(
  overrides: Partial<AccountIdentityDto> = {},
): AccountIdentityDto {
  return AccountIdentityDto.parse({
    accountId: DEFAULT_ACCOUNT.id,
    email: 'builder@example.com',
    organization: null,
    apiProvider: 'firstParty',
    apiKeySource: null,
    tokenSource: null,
    subscription: true,
    refusal: null,
    ...overrides,
  });
}

/** A pause that began on 2026-10-30 and has no end, as a refusal does. */
export function accountPauseDto(overrides: Partial<AccountPauseDto> = {}): AccountPauseDto {
  return AccountPauseDto.parse({
    accountId: DEFAULT_ACCOUNT.id,
    reason: 'refused',
    since: '2026-10-30T18:00:00.000Z',
    until: null,
    ...overrides,
  });
}

export function accountSignInDto(overrides: Partial<AccountSignInDto> = {}): AccountSignInDto {
  return AccountSignInDto.parse({
    accountId: DEFAULT_ACCOUNT.id,
    configDir: '/data/accounts/a/claude',
    command: 'CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude',
    ...overrides,
  });
}
