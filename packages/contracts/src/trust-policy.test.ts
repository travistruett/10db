import { describe, expect, it } from 'vitest';
import { LiveSystem, TRUST_DEFAULTS, TrustPolicy } from './index';

describe('LiveSystem', () => {
  it.each([
    ['a host passes', 'api.example.com', true],
    ['an AWS profile name passes', 'prod-admin', true],
    ['an empty string fails', '', false],
    ['201 characters fail', 'a'.repeat(201), false],
    ['a newline fails', 'api.example.com\nhard_deny', false],
    ['a tab fails', 'api\texample', false],
    ['a NUL fails', 'api\u0000example', false],
    ['a U+2028 fails', 'api\u2028example', false],
    ['$defaults fails', '$defaults', false],
  ])('%s', (_name, value, ok) => {
    expect(LiveSystem.safeParse(value).success).toBe(ok);
  });
});

describe('TrustPolicy', () => {
  const limit = (name: string) => ({ name, label: 'L', text: 'T' });
  const policy = (limits: unknown[]) => ({
    surface: 'lane',
    attended: false,
    limits,
    environment: [],
    coordination: [],
    allow: [],
    switches: TRUST_DEFAULTS,
  });
  it.each([
    [
      'four limits pass',
      [
        limit('destroys_data'),
        limit('sends_data_out'),
        limit('reads_secrets'),
        limit('writes_live'),
      ],
      true,
    ],
    [
      'three limits fail',
      [limit('destroys_data'), limit('sends_data_out'), limit('reads_secrets')],
      false,
    ],
    [
      'a limit with an unknown name fails',
      [limit('destroys_data'), limit('sends_data_out'), limit('reads_secrets'), limit('nukes')],
      false,
    ],
  ])('%s', (_name, limits, ok) => {
    expect(TrustPolicy.safeParse(policy(limits)).success).toBe(ok);
  });
});
