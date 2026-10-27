import { AccountDto, mintId } from '@10db/contracts';

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
